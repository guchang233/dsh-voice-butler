import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * butler-bridge —— 语音壳（Electron「管家」）与 DSH 管家会话之间的唯一通道。
 *
 * 分工：
 *   · 语音壳只管听和说：唤醒词 → 录音 → ASR → 把一句话丢过来；把回话念出来。
 *   · 想和做全在这条 DSH 会话里（预设 id = butler，即「管家模式」）。
 *
 * 只有一条前缀路由 /voice，下面按子路径分发：
 *   GET  /voice/ping                存活与身份
 *   GET  /voice/state               会话状态快照
 *   POST /voice/say    {text}       把一句话投进管家会话，触发一轮
 *   GET  /voice/frames ?cursor&wait 增量取帧（长轮询：助手增量、工具、确认）
 *   POST /voice/approve {id,allow}  回答确认卡片
 *   POST /voice/stop                打断当前这一轮
 *   POST /voice/new                 换一条新的管家会话
 */

export const name = 'butler-bridge'
export const inject = ['webServer', 'sessionController']

const ROUTE_PREFIX = '/voice'

const TARGET_CWD = process.env.BUTLER_CWD || 'D:\\AI\\ClaudeCode\\语音管家'
const PRESET = process.env.BUTLER_PRESET || 'butler'
const SESSION_TITLE = process.env.BUTLER_SESSION_TITLE || 'DSH语音管家'

const STATE_DIR = path.join(os.homedir(), '.dsh', 'butler-bridge')
const STATE_FILE = path.join(STATE_DIR, 'state.json')
const ENDPOINT_FILE = path.join(STATE_DIR, 'endpoint.json')

const MAX_FRAMES = 4000
/** 面板多久没来取帧，就不再替它拦确认（还给 DSH 自己的界面） */
const PANEL_STALE_MS = 25_000
/** 确认卡片最多等多久，超时按取消处理，避免工具调用挂死 */
const APPROVAL_TIMEOUT_MS = 90_000
const POLL_WAIT_DEFAULT = 20_000
const POLL_WAIT_MAX = 25_000

/* ------------------------------------------------------------------ 小工具 */

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJsonFile(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

function sendJson(res, code, body) {
  if (res.headersSent) {
    res.end()
    return
  }
  const payload = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store'
  })
  res.end(payload)
}

function readBody(req, limit = 128 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size <= limit) chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

/** 只认回环 Host：这道门后面是本机语音壳。 */
function trusted(req) {
  const host = String(req.headers.host ?? '')
  const name = host.replace(/:\d+$/, '').toLowerCase()
  const loopback = name === '127.0.0.1' || name === 'localhost' || name === '::1' || name === '[::1]'
  if (!loopback) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin) {
    try {
      if (new URL(origin).host !== host) return false
    } catch {
      return false
    }
  }
  return true
}

function textOf(content) {
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      out += block.text
    }
  }
  return out
}

function clip(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > max ? value.slice(0, max) + '…' : value
}

/** 运行时注入的上下文（system-reminder / 技能清单）不是人说的话，别推到面板上 */
function looksInjected(text) {
  const head = String(text ?? '').trimStart().slice(0, 40).toLowerCase()
  return head.startsWith('<system-reminder') || head.startsWith('<available_skills')
}

/** 面板上那一行工具摘要（参数太长，只抽最有意义的字段） */
function summarizeTool(rawArgs) {
  let args = {}
  try {
    args = JSON.parse(rawArgs || '{}')
  } catch {
    args = {}
  }
  for (const key of ['command', 'description', 'path', 'file_path', 'query', 'pattern', 'url', 'prompt']) {
    const value = args?.[key]
    if (typeof value === 'string' && value.trim()) return clip(value, 140)
  }
  return clip(rawArgs, 140)
}

/* -------------------------------------------------------------------- 主体 */

export function apply(ctx) {
  const logger = ctx.logger ?? console
  const state = readJsonFile(STATE_FILE, {})
  const controller = ctx.sessionController

  let frames = []
  let seq = 0
  const waiters = new Set()
  let lastPanelPollAt = 0
  const pendingApprovals = new Map()

  let sessionId = typeof state.sessionId === 'string' ? state.sessionId : null
  let running = false
  let phase = 'idle'
  let lastError = ''
  let presetOk = null

  function wakePollers() {
    for (const deliver of [...waiters]) deliver()
    waiters.clear()
  }

  function push(frame) {
    seq += 1
    frames.push({ seq, ...frame })
    if (frames.length > MAX_FRAMES) frames.splice(0, frames.length - MAX_FRAMES)
    wakePollers()
  }

  function drain(sinceSeq, budget = 260) {
    const out = []
    for (const frame of frames) {
      if (frame.seq <= sinceSeq) continue
      const last = out[out.length - 1]
      if (last && last.t === 'delta' && frame.t === 'delta') {
        last.text += frame.text
        continue
      }
      out.push({ ...frame })
      if (out.length >= budget) break
    }
    return out
  }

  function setPhase(next) {
    if (phase === next) return
    phase = next
    push({ t: 'state', running, phase })
  }

  function setRunning(next) {
    if (running === next) return
    running = next
    push({ t: 'state', running, phase })
  }

  /* -------------------------------------------------------- 会话：找/建/记 */

  function writeEndpoint() {
    let origin = ''
    try {
      origin = ctx.webServer.getOrigin()
    } catch {
      origin = ''
    }
    // 监听还没起来时 getOrigin 会抛；1.5 秒后再写一次
    if (!origin) {
      setTimeout(() => {
        try {
          const late = ctx.webServer.getOrigin()
          if (late) writeJsonFile(ENDPOINT_FILE, { origin: late, sessionId, preset: PRESET, updatedAt: Date.now() })
        } catch {
          /* 仍然没有就等下一次心跳 */
        }
      }, 1500)
    }
    writeJsonFile(ENDPOINT_FILE, {
      origin,
      sessionId,
      preset: PRESET,
      updatedAt: Date.now()
    })
  }

  function remember(nextId) {
    sessionId = nextId
    state.sessionId = nextId
    state.updatedAt = Date.now()
    writeJsonFile(STATE_FILE, state)
    push({ t: 'hello', sessionId: nextId, preset: PRESET, title: SESSION_TITLE })
    writeEndpoint()
  }

  /** agentPresets.resolve 是异步的，只探一次并缓存 */
  async function probePreset() {
    if (presetOk !== null) return presetOk
    const presets = ctx.get('agentPresets')
    if (!presets || typeof presets.resolve !== 'function') {
      presetOk = false
      return presetOk
    }
    try {
      await presets.resolve(PRESET)
      presetOk = true
    } catch (error) {
      presetOk = false
      logger?.warn?.(`[butler-bridge] 预设 ${PRESET} 不可用：${error?.message ?? error}`)
    }
    return presetOk
  }

  function findWorkspace() {
    const registry = ctx.get('workspaceRegistry')
    if (!registry) return null
    let pool = []
    try {
      pool = typeof registry.list === 'function' ? registry.list() : []
    } catch {
      pool = []
    }
    for (const ws of pool ?? []) {
      const dir = ws?.path ?? ws?.record?.path
      if (typeof dir === 'string' && dir.toLowerCase() === TARGET_CWD.toLowerCase()) return ws
    }
    return null
  }

  async function ensureWorkspaceId() {
    const registry = ctx.get('workspaceRegistry')
    if (!registry) return undefined
    try {
      const existing = findWorkspace()
      if (existing?.id) return existing.id
      if (typeof registry.create === 'function') {
        const created = await registry.create(TARGET_CWD, '语音管家')
        return created?.id
      }
    } catch (error) {
      logger?.warn?.('[butler-bridge] 工作区准备失败：' + (error?.message ?? error))
    }
    return undefined
  }

  async function createSession() {
    // session.create 只接受 workspaceId 或 cwd 之一：有工作区就挂进去，没有就用目录
    const workspaceId = await ensureWorkspaceId()
    const request = workspaceId ? { workspaceId } : { cwd: TARGET_CWD }
    if (await probePreset()) request.agentPreset = PRESET
    else logger?.warn?.(`[butler-bridge] 预设 ${PRESET} 不在册，这条会话将用默认模式`)

    const created = await controller.create(request)
    const id = created?.sessionId
    if (!id) throw new Error('sessionController.create 没有返回 sessionId')
    try {
      await controller.rename({ sessionId: id, title: SESSION_TITLE })
    } catch (error) {
      logger?.warn?.('[butler-bridge] 会话改名失败：' + (error?.message ?? error))
    }
    return id
  }

  async function sessionAlive(id) {
    try {
      await controller.state({ sessionId: id }, AbortSignal.timeout(8000))
      return true
    } catch {
      return false
    }
  }

  async function ensureSession() {
    if (sessionId && (await sessionAlive(sessionId))) return sessionId
    const id = await createSession()
    remember(id)
    logger?.info?.(`[butler-bridge] 管家会话：${id}（preset=${presetOk ? PRESET : 'default'}）`)
    return id
  }

  /* ------------------------------------------------------------- 会话事件流 */

  function isButler(id) {
    return typeof id === 'string' && sessionId !== null && id === sessionId
  }

  const offEvent = ctx.on('session/event', (session, event) => {
    try {
      if (!isButler(session?.id)) return
      const data = event?.data ?? {}
      switch (event.type) {
        case 'turn/start':
          setRunning(true)
          setPhase('thinking')
          break
        case 'user/message': {
          const text = textOf(data.content)
          if (text && !looksInjected(text)) push({ t: 'user', text, at: event.time ?? Date.now() })
          break
        }
        case 'assistant/message': {
          const text = textOf(data.message?.content)
          if (text) {
            push({ t: 'reply', text, at: event.time ?? Date.now(), interrupted: data.interrupted === true })
          }
          setPhase('thinking')
          break
        }
        case 'tool/call':
          setPhase('tool')
          push({
            t: 'tool',
            phase: 'start',
            id: String(data.callId ?? ''),
            name: String(data.name ?? ''),
            args: summarizeTool(data.arguments)
          })
          break
        case 'tool/result':
          push({
            t: 'tool',
            phase: 'end',
            id: String(data.message?.toolCallId ?? ''),
            name: '',
            ok: !data.error,
            detail: clip(textOf(data.message?.content), 200)
          })
          setPhase('thinking')
          break
        case 'turn/end': {
          const reason = data.reason ?? {}
          setRunning(false)
          setPhase('idle')
          if (reason.kind === 'error' || reason.kind === 'aborted' || reason.kind === 'blocked') {
            lastError = reason.kind === 'aborted' ? '已被打断' : reason.error?.message || reason.kind
            push({ t: 'error', message: lastError })
          }
          break
        }
        default:
          break
      }
    } catch (error) {
      logger?.warn?.('[butler-bridge] 事件处理失败：' + (error?.message ?? error))
    }
  })

  /** 逐字增量：面板与念稿都靠它跟得上模型 */
  const offStream = ctx.on('agent/assistant-stream', (payload) => {
    try {
      if (!isButler(payload?.agent?.id)) return
      const frame = payload?.frame
      if (frame?.type !== 'chunk') return
      const chunk = frame.chunk
      if (chunk?.type !== 'text-delta' || !chunk.text) return
      push({ t: 'delta', text: chunk.text })
    } catch {
      /* 增量失败不影响主流程 */
    }
  })

  const offStatus = ctx.on('agent/status', (payload) => {
    try {
      if (!isButler(payload?.agent?.id)) return
      const isRunning = payload.status === 'running'
      setRunning(isRunning)
      if (!isRunning) setPhase('idle')
    } catch {
      /* ignore */
    }
  })

  /* --------------------------------------------------------- 确认：语音壳代签 */

  /**
   * 只接管家会话的确认，其它会话一律 next() 交回 DSH。
   * 面板最近没在取帧（壳没开）时也不接，免得把工具调用挂住。
   */
  const offApproval = ctx.on('approval/request', async (req, next) => {
    try {
      if (!isButler(req?.agent?.id)) return next()
      if (Date.now() - lastPanelPollAt > PANEL_STALE_MS) return next()

      const id = randomUUID()
      const reason = req.displayReason?.zh ?? req.displayReason?.en ?? req.reason ?? ''
      push({ t: 'approval', id, tool: String(req.toolName ?? ''), reason: clip(reason, 200) })

      const outcome = await new Promise((resolve) => {
        let timer = null
        const finish = (value) => {
          if (timer) clearTimeout(timer)
          pendingApprovals.delete(id)
          if (req.signal) req.signal.removeEventListener('abort', onAbort)
          resolve(value)
        }
        const onAbort = () => finish('cancelled')
        timer = setTimeout(() => finish('cancelled'), APPROVAL_TIMEOUT_MS)
        pendingApprovals.set(id, finish)
        if (req.signal) {
          if (req.signal.aborted) return finish('cancelled')
          req.signal.addEventListener('abort', onAbort, { once: true })
        }
      })

      push({ t: 'approval-done', id, outcome })
      logger?.info?.(`[butler-bridge] 确认 ${req.toolName} → ${outcome}`)
      return outcome
    } catch (error) {
      logger?.warn?.('[butler-bridge] 确认处理失败：' + (error?.message ?? error))
      return next()
    }
  })

  /* ------------------------------------------------------------------ 路由 */

  function snapshot() {
    return {
      sessionId,
      preset: presetOk ? PRESET : null,
      title: SESSION_TITLE,
      running,
      phase,
      cursor: seq,
      pending: [...pendingApprovals.keys()],
      /** 语音壳最近 25 秒有没有在取帧（等于壳开没开） */
      panelActive: Date.now() - lastPanelPollAt < PANEL_STALE_MS,
      error: lastError || null
    }
  }

  /** 冷启动补历史：只要人说的话和助手回的话，工具轨迹不要 */
  async function readHistory(id) {
    const page = await controller.events(
      { address: { kind: 'session', sessionId: id }, maxMessages: 40 },
      AbortSignal.timeout(8000)
    )
    const out = []
    for (const record of page?.records ?? []) {
      const event = record?.event
      if (!event) continue
      if (event.type === 'user/message') {
        const text = textOf(event.data?.content)
        if (text && !looksInjected(text)) out.push({ t: 'user', text, at: event.time })
      } else if (event.type === 'assistant/message') {
        const text = textOf(event.data?.message?.content)
        if (text) out.push({ t: 'reply', text, at: event.time })
      }
    }
    return out.slice(-24)
  }

  async function handle(req, res, url) {
    const p = url.pathname
    const method = req.method ?? 'GET'

    if (p === `${ROUTE_PREFIX}/ping`) {
      return sendJson(res, 200, { ok: true, service: 'butler-bridge', version: 2, ...snapshot() })
    }

    if (p === `${ROUTE_PREFIX}/state`) {
      return sendJson(res, 200, { ok: true, ...snapshot() })
    }

    if (p === `${ROUTE_PREFIX}/say`) {
      if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
      const body = await readBody(req)
      const text = String(body.text ?? '').trim()
      if (!text) return sendJson(res, 400, { ok: false, error: 'empty text' })
      const id = await ensureSession()
      const requestId = randomUUID()
      await controller.prompt(
        { sessionId: id, requestId, mode: 'queue', content: [{ type: 'text', text }] },
        AbortSignal.timeout(30_000)
      )
      logger?.info?.(`[butler-bridge] → ${text.slice(0, 60)}`)
      return sendJson(res, 200, { ok: true, sessionId: id, requestId })
    }

    if (p === `${ROUTE_PREFIX}/frames`) {
      const cursorRaw = Number(url.searchParams.get('cursor'))
      const waitRaw = Number(url.searchParams.get('wait'))
      const wait = Number.isFinite(waitRaw)
        ? Math.max(0, Math.min(POLL_WAIT_MAX, waitRaw))
        : POLL_WAIT_DEFAULT
      lastPanelPollAt = Date.now()

      const since = Number.isFinite(cursorRaw) && cursorRaw >= 0 ? cursorRaw : -1
      const firstSeq = frames.length ? frames[0].seq : 0

      // 壳刚起来（cursor<0），或者缓冲已经滚过它读到的位置：先给一段历史
      if (since < 0 || (firstSeq > 0 && since < firstSeq - 1)) {
        let history = []
        if (sessionId) history = await readHistory(sessionId).catch(() => [])
        return sendJson(res, 200, {
          ok: true,
          reset: true,
          history,
          cursor: seq,
          frames: frames.map((frame) => ({ ...frame })),
          ...snapshot()
        })
      }

      let batch = drain(since)
      if (!batch.length && wait > 0) {
        await new Promise((resolve) => {
          const done = () => {
            clearTimeout(timer)
            waiters.delete(done)
            resolve()
          }
          const timer = setTimeout(done, wait)
          waiters.add(done)
        })
        // 逐字增量是一条一条来的；等 60ms 再收一次，把这段时间的 delta 并成一片
        await new Promise((resolve) => setTimeout(resolve, 60))
      }
      batch = drain(since)
      return sendJson(res, 200, { ok: true, cursor: seq, frames: batch, ...snapshot() })
    }

    if (p === `${ROUTE_PREFIX}/approve`) {
      if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
      const body = await readBody(req)
      const id = String(body.id ?? '')
      const allow = body.allow === true
      const finish = pendingApprovals.get(id)
      if (!finish) return sendJson(res, 404, { ok: false, error: '这个确认已经过期了' })
      finish(allow ? 'allowed-once' : 'rejected')
      return sendJson(res, 200, { ok: true })
    }

    if (p === `${ROUTE_PREFIX}/stop`) {
      if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
      if (!sessionId) return sendJson(res, 409, { ok: false, error: '还没有管家会话' })
      controller.cancel({ sessionId })
      for (const [id, finish] of [...pendingApprovals]) {
        finish('cancelled')
        pendingApprovals.delete(id)
      }
      push({ t: 'state', running: false, phase: 'idle' })
      return sendJson(res, 200, { ok: true })
    }

    if (p === `${ROUTE_PREFIX}/new`) {
      if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
      const id = await createSession()
      frames = []
      seq = 0
      remember(id)
      push({ t: 'reset' })
      return sendJson(res, 200, { ok: true, sessionId: id })
    }

    return sendJson(res, 404, { ok: false, error: 'unknown route ' + p })
  }

  let disposeRoute = null
  try {
    disposeRoute = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        if (!trusted(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' })
        const url = new URL(req.url ?? ROUTE_PREFIX, 'http://127.0.0.1')
        try {
          await handle(req, res, url)
        } catch (error) {
          const message = String(error?.message ?? error)
          logger?.warn?.(`[butler-bridge] ${url.pathname} 失败：${message}`)
          lastError = message
          sendJson(res, 500, { ok: false, error: message })
        }
      }
    })
  } catch (error) {
    logger?.error?.(
      `[butler-bridge] 路由 ${ROUTE_PREFIX} 注册失败（多半是上一个实例还占着，重开一次 DSH 即可）：${
        error?.message ?? error
      }`
    )
  }

  /* --------------------------------------------------------------- 生命周期 */

  writeEndpoint()
  const endpointTimer = setInterval(writeEndpoint, 10_000)
  if (typeof endpointTimer.unref === 'function') endpointTimer.unref()

  void (async () => {
    try {
      await probePreset()
      await ensureSession()
      // 会话定下来了，立刻把 endpoint 写成真的（第一笔可能早于 listen 与会话创建）
      writeEndpoint()
    } catch (error) {
      lastError = String(error?.message ?? error)
      logger?.warn?.('[butler-bridge] 初始化管家会话失败：' + lastError)
    }
  })()

  ctx.effect(() => {
    logger?.info?.(
      `[butler-bridge] 就绪：${ROUTE_PREFIX}/ping /say /frames /approve /stop /new`
    )
    return () => {
      clearInterval(endpointTimer)
      try {
        offEvent?.()
        offStream?.()
        offStatus?.()
        offApproval?.()
      } catch {
        /* ignore */
      }
      try {
        disposeRoute?.()
      } catch {
        /* ignore */
      }
      for (const finish of [...pendingApprovals.values()]) finish('cancelled')
      pendingApprovals.clear()
      wakePollers()
      logger?.info?.('[butler-bridge] 已卸载')
    }
  })
}
