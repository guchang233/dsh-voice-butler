# butler-bridge

DSH 侧的桥。语音壳（Electron「管家」）只负责听和说，**这条桥是它和管家会话之间唯一的通道**。

- 收一句话 → 投进「DSH语音管家」会话（预设 `butler` ＝ 管家模式）
- 把会话里发生的事增量推回去：助手逐字输出、每一次工具调用、确认请求、运行状态
- 顺手替语音壳回答确认（只限这条会话，且只在壳正在取帧时）

## 路由

全部挂在一条前缀路由 `/voice` 下，只认回环 Host。

| 方法与路径 | 作用 |
|---|---|
| `GET /voice/ping` | 存活、会话 id、预设、运行状态 |
| `GET /voice/state` | 同上，轻量快照 |
| `POST /voice/say` | `{text}` → 投进会话，触发一轮 |
| `GET /voice/frames?cursor=&wait=` | 增量取帧，长轮询（默认等 20 秒，最多 25 秒） |
| `POST /voice/approve` | `{id,allow}` → 回答确认卡片 |
| `POST /voice/stop` | 打断当前这一轮 |
| `POST /voice/new` | 换一条新的管家会话 |

### 帧

```jsonc
{"seq":1,"t":"hello","sessionId":"…","preset":"butler","title":"DSH语音管家"}
{"seq":2,"t":"state","running":true,"phase":"thinking"}     // phase: idle | thinking | tool
{"seq":3,"t":"user","text":"现在几点了"}
{"seq":4,"t":"delta","text":"现在"}                          // 逐字增量，念稿用
{"seq":5,"t":"tool","phase":"start","id":"call-1","name":"pwsh","args":"Get-Date"}
{"seq":6,"t":"tool","phase":"end","id":"call-1","ok":true,"detail":"2026年…"}
{"seq":7,"t":"reply","text":"现在是…","interrupted":false}     // 这一段说完了
{"seq":8,"t":"approval","id":"uuid","tool":"pwsh","reason":"…"}
{"seq":9,"t":"approval-done","id":"uuid","outcome":"allowed-once"}
{"seq":10,"t":"error","message":"…"}
{"seq":11,"t":"reset"}                                       // 换会话
```

`cursor` 是上一次返回的 `cursor`；带 `cursor=-1`（或缓冲已经滚过去）会拿到 `reset:true` + 一段历史。
帧里的助手增量会合并相邻的 `delta`，一次取回不会碎成一万条。

## 会话从哪来

第一次加载时按 `~/.dsh/butler-bridge/state.json` 里记的 id 找会话；
找不到就新建一条（`cwd = D:\AI\ClaudeCode\语音管家`，挂了工作区就挂进去），
预设取 `butler`，并改名为 **DSH语音管家**。

- 会话 id 记在 `state.json`
- DSH 地址写给壳：`endpoint.json`（每 20 秒刷新）
- 想换会话：`POST /voice/new`，或直接删 `state.json` 后重开 DSH

## 确认（approval）

`ctx.on('approval/request')` 的 waterfall 上，只有**管家会话**的请求会被这里接走，
其它会话一律 `next()` 交回 DSH。加两道保险：

- 语音壳最近 25 秒没来取帧（等于没开）→ 不接，交回 DSH 自己的界面
- 90 秒没人回答 → 按「取消」结束，避免工具调用挂死

接走之后：帧里推 `approval`，壳用嘴问一句、面板上给按钮，答完回 `allowed-once` / `rejected`。

## 实现要点

- 用 `ctx.effect()` 收尾（Cordis 没有 `dispose` 事件，注册在 effect 里才会随插件卸载一起撤）
- 会话事件走 `session/event`，逐字增量走 `agent/assistant-stream`，运行状态走 `agent/status`
- 只认回环 Host，带 Origin 时必须同源
- 帧缓冲是 4000 条的环形队列，长轮询用等待者集合唤醒

## 依赖的 Host 服务

`webServer`、`sessionController`；可选 `agentPresets`、`workspaceRegistry`（缺了就退化成默认模式 / 不挂工作区）。
