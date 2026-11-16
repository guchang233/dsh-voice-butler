import { ipcMain, nativeTheme } from 'electron'
import { z } from 'zod'
import { IPC, type ThemeMode } from '../shared/ipc'
import { getBridge } from './bridge'
import { importCustomSkin, listCustomSkins, removeCustomSkin, renameCustomSkin } from './customSkins'
import { logError, logInfo } from './log'
import { buildPeekData } from './peek'
import {
  getApiKey,
  getAsrKey,
  getAsrKeys,
  saveApiKey,
  saveAsrKey,
  savePreferences,
  getSettings,
} from './store'
import { verifyAsrKey } from './speech/asr'
import { syncOverlay } from './overlay'
import { getVoice } from './voice'
import {
  broadcastSkin,
  endDrag,
  getBall,
  getOverlay,
  getPanel,
  getPeek,
  hidePanel,
  applyBallLevel,
  hidePeek,
  peekVisible,
  showPeekWith,
  startDrag,
  togglePanel,
} from './windows'

const settingsPatch = z.object({
  apiKey: z.string().max(400).optional(),
  baseUrl: z.string().max(300).optional(),
  micEnabled: z.boolean().optional(),
  ttsVoice: z.enum(['stella', 'tide']).optional(),
  bargeIn: z.boolean().optional(),
  dshOrigin: z.string().max(300).optional(),
  theme: z.enum(['system', 'light', 'dark']).optional(),
  accent: z.enum(['none', 'rose', 'ocean']).optional(),
  effect: z.enum(['off', 'soft', 'vivid']).optional(),
  continuous: z.boolean().optional(),
  ballLevel: z.enum(['top', 'float', 'normal']).optional(),
  asrProvider: z.enum(['siliconflow', 'dashscope', 'deepseek']).optional(),
  asrModel: z.string().max(120).optional(),
  asrApiKey: z.string().max(400).optional(),
})

/** 主题一改，三个窗口一起跟着变（CSS 里用的是 prefers-color-scheme） */
export function applyTheme(mode: ThemeMode): void {
  nativeTheme.themeSource = mode
  logInfo('theme', mode)
}

/** 皮肤键必须是「内置的」或「确实导入过的」，否则退回鲸鱼娘 */
function resolveSkinKey(key: string): string {
  const clean = key.trim()
  if (clean === 'whale' || clean === 'niang02') return clean
  const known = listCustomSkins().some((item) => item.key === clean)
  return known ? clean : 'whale'
}

/** 只校验语音接口能不能用（GET /models，不花钱），不涉及对话 */
async function verifyKey(baseUrl: string, apiKey: string): Promise<void> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  })
  if (res.ok) return
  const map: Record<number, string> = {
    401: 'Key 无效（401）',
    402: '账户余额不足（402）',
    429: '请求过于频繁（429）',
  }
  throw new Error(map[res.status] ?? `校验失败（HTTP ${res.status}）`)
}

function publishSettings(): void {
  const bridge = getBridge().status()
  const payload = {
    ...getSettings(),
    sessionId: bridge.sessionId,
    sessionTitle: 'DSH语音管家',
  }
  for (const win of [getBall(), getPanel(), getPeek(), getOverlay()]) {
    if (win && !win.isDestroyed()) win.webContents.send(IPC.settingsChanged, payload)
  }
}

export function registerIpc(): void {
  ipcMain.handle(IPC.settingsGet, () => {
    const bridge = getBridge().status()
    return {
      ...getSettings(),
      sessionId: bridge.sessionId,
      sessionTitle: 'DSH语音管家',
    }
  })

  ipcMain.handle(IPC.settingsSave, async (_event, raw: unknown) => {
    const parsed = settingsPatch.safeParse(raw)
    if (!parsed.success) return { ok: false as const, error: '设置格式不正确' }
    const patch = parsed.data

    // 识别厂商先定下来，后面的 Key 才知道存到谁名下
    if (patch.asrProvider !== undefined) savePreferences({ asrProvider: patch.asrProvider })
    if (patch.asrApiKey !== undefined) {
      const provider = patch.asrProvider ?? getSettings().asrProvider
      const trimmed = patch.asrApiKey.trim()
      if (trimmed) {
        try {
          await verifyAsrKey(provider, trimmed, {
        baseUrl: patch.baseUrl ?? getSettings().baseUrl,
        model: patch.asrModel ?? getSettings().asrModel
      })
        } catch (error) {
          return { ok: false as const, error: error instanceof Error ? error.message : '识别 Key 校验失败' }
        }
      }
      saveAsrKey(provider, trimmed)
    }

    if (patch.apiKey !== undefined && patch.apiKey.trim().length > 0) {
      const baseUrl = (patch.baseUrl ?? getSettings().baseUrl).replace(/\/+$/, '')
      try {
        await verifyKey(baseUrl, patch.apiKey.trim())
      } catch (error) {
        return { ok: false as const, error: error instanceof Error ? error.message : '校验失败' }
      }
      saveApiKey(patch.apiKey)
    } else if (patch.apiKey !== undefined) {
      saveApiKey('')
    }

    savePreferences({
      baseUrl: patch.baseUrl,
      micEnabled: patch.micEnabled,
      ttsVoice: patch.ttsVoice,
      bargeIn: patch.bargeIn,
      dshOrigin: patch.dshOrigin,
      theme: patch.theme,
      accent: patch.accent,
      effect: patch.effect,
      continuous: patch.continuous,
      ballLevel: patch.ballLevel,
      asrProvider: patch.asrProvider,
      asrModel: patch.asrModel,
    })
    if (patch.micEnabled !== undefined) getVoice().setMicEnabled(patch.micEnabled)
    if (patch.theme !== undefined) applyTheme(patch.theme)
    if (patch.continuous !== undefined) getVoice().setContinuous(patch.continuous)
    if (patch.ballLevel !== undefined) {
      applyBallLevel(patch.ballLevel)
      logInfo('layers', 'ball level = ' + patch.ballLevel)
    }
    publishSettings()
    syncOverlay()
    return { ok: true as const }
  })

  ipcMain.handle(IPC.settingsVerify, async (_event, raw: unknown) => {
    const key = z.string().max(400).safeParse(raw)
    if (!key.success) return { ok: false as const, error: 'Key 格式不正确' }
    try {
      await verifyKey(getSettings().baseUrl, key.data.trim())
      return { ok: true as const }
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : '校验失败' }
    }
  })

  ipcMain.handle(IPC.panelToggle, () => togglePanel())
  ipcMain.handle(IPC.panelHide, () => hidePanel())

  ipcMain.handle(IPC.skinGet, () => getSettings().skin)

  /** 换贴图：内置的两张 + 用户导入的都走这里；存进去的键必须真的存在 */
  ipcMain.handle(IPC.skinSet, (_e, skin: unknown) => {
    const parsed = z.string().max(80).safeParse(skin)
    const next = resolveSkinKey(parsed.success ? parsed.data : 'whale')
    savePreferences({ skin: next })
    broadcastSkin(next)
    logInfo('skin', next)
    return next
  })

  ipcMain.handle(IPC.skinCatalog, () => listCustomSkins())

  /** 导入成功后直接换上，不用再点一次 */
  ipcMain.handle(IPC.skinImport, async () => {
    const result = await importCustomSkin()
    if (result.ok && result.key) {
      const next = resolveSkinKey(result.key)
      savePreferences({ skin: next })
      broadcastSkin(next)
      return { ...result, key: next }
    }
    return result
  })

  /** 删掉的正好是当前那张，就退回鲸鱼娘 */
  ipcMain.handle(IPC.skinRemove, (_e, key: unknown) => {
    const parsed = z.string().max(80).safeParse(key)
    if (!parsed.success) return false
    const removed = removeCustomSkin(parsed.data)
    if (removed && getSettings().skin === parsed.data) {
      savePreferences({ skin: 'whale' })
      broadcastSkin('whale')
    }
    return removed
  })

  /** 右键改名：只动显示名 */
  ipcMain.handle(IPC.skinRename, (_e, raw: unknown) => {
    const parsed = z.object({ key: z.string().max(80), label: z.string().max(60) }).safeParse(raw)
    if (!parsed.success) return { ok: false, error: '名字格式不正确' }
    return renameCustomSkin(parsed.data.key, parsed.data.label)
  })

  ipcMain.on(IPC.ballDragStart, () => startDrag())
  ipcMain.on(IPC.ballDragEnd, () => endDrag())

  /* --------------------------------------------------------------- 音频 */

  ipcMain.on(IPC.audioFeed, (_event, chunk: unknown) => {
    if (chunk instanceof Int16Array) getVoice().onChunk(chunk)
    else if (chunk instanceof ArrayBuffer) getVoice().onChunk(new Int16Array(chunk))
  })

  ipcMain.on(IPC.micEnabled, (_event, enabled: unknown) => {
    getVoice().setMicEnabled(enabled === true)
  })

  ipcMain.on(IPC.voicePtt, (_event, down: unknown) => {
    getVoice().pushToTalk(down === true)
  })

  /** 球窗报告：最后一段音频播完了（连续对话等这个信号才开麦） */
  ipcMain.on(IPC.speechDrained, () => {
    logInfo('ipc', 'speech drained（球窗回报）')
    getVoice().onPlaybackIdle()
  })

  /* --------------------------------------------------- 与 DSH 的四个动作 */

  ipcMain.handle(IPC.voiceSay, async (_event, raw: unknown) => {
    const text = z.string().max(4000).safeParse(raw)
    if (!text.success) return { ok: false as const, error: '消息格式不正确' }
    const clean = text.data.trim()
    if (!clean) return { ok: false as const, error: '空的' }
    try {
      await getVoice().deliver(clean)
      return { ok: true as const }
    } catch (error) {
      logError('voiceSay', error)
      return { ok: false as const, error: String((error as Error)?.message ?? error) }
    }
  })

  ipcMain.handle(IPC.voiceStop, async () => {
    try {
      getVoice().interruptTurn()
      return { ok: true as const }
    } catch (error) {
      return { ok: false as const, error: String((error as Error)?.message ?? error) }
    }
  })

  ipcMain.handle(IPC.voiceApprove, async (_event, raw: unknown) => {
    const parsed = z.object({ id: z.string().max(80), allow: z.boolean() }).safeParse(raw)
    if (!parsed.success) return { ok: false as const, error: '格式不正确' }
    try {
      await getBridge().approve(parsed.data.id, parsed.data.allow)
      return { ok: true as const }
    } catch (error) {
      return { ok: false as const, error: String((error as Error)?.message ?? error) }
    }
  })

  ipcMain.handle(IPC.voiceNew, async () => {
    try {
      await getBridge().newSession()
      return { ok: true as const }
    } catch (error) {
      return { ok: false as const, error: String((error as Error)?.message ?? error) }
    }
  })

  ipcMain.handle(IPC.voiceStatus, () => {
    const bridge = getBridge().status()
    return {
      link: bridge.link,
      state: getVoice().getState(),
      sessionId: bridge.sessionId,
      sessionTitle: 'DSH语音管家',
      preset: bridge.preset,
      running: bridge.running,
      origin: bridge.origin,
      lastError: bridge.lastError,
    }
  })

  /* ------------------------------------------------------------ 明文密钥（回填输入框用） */

  ipcMain.handle(IPC.secretsReveal, () => {
    try {
      return { ok: true as const, apiKey: getApiKey(), asrKeys: getAsrKeys() }
    } catch (error) {
      logError('secrets.reveal', error)
      return { ok: false as const, error: String((error as Error)?.message ?? error) }
    }
  })

  /* ------------------------------------------------------------ 会话与模型 */

  ipcMain.handle(IPC.sessionsList, async () => {
    try {
      return { ok: true as const, items: await getBridge().listSessions() }
    } catch (error) {
      logError('sessions.list', error)
      return { ok: false as const, error: String((error as Error)?.message ?? error) }
    }
  })

  ipcMain.handle(IPC.sessionSwitch, async (_event, raw: unknown) => {
    const parsed = z.string().min(3).max(200).safeParse(raw)
    if (!parsed.success) return { ok: false as const, error: '会话 id 不对' }
    try {
      await getBridge().switchSession(parsed.data)
      logInfo('sessions.switch', parsed.data)
      return { ok: true as const }
    } catch (error) {
      logError('sessions.switch', error)
      return { ok: false as const, error: String((error as Error)?.message ?? error) }
    }
  })

  ipcMain.handle(IPC.modelsList, async () => {
    try {
      return { ok: true as const, catalog: await getBridge().listModels() }
    } catch (error) {
      logError('models.list', error)
      return { ok: false as const, error: String((error as Error)?.message ?? error) }
    }
  })

  ipcMain.handle(IPC.modelSelect, async (_event, raw: unknown) => {
    const parsed = z
      .object({
        provider: z.string().min(1).max(80),
        model: z.string().min(1).max(120),
        effort: z.string().min(1).max(40).optional()
      })
      .safeParse(raw)
    if (!parsed.success) return { ok: false as const, error: '模型参数不对' }
    try {
      await getBridge().selectModel(parsed.data.provider, parsed.data.model, parsed.data.effort)
      logInfo('models.select', `${parsed.data.provider}/${parsed.data.model}`)
      return { ok: true as const }
    } catch (error) {
      logError('models.select', error)
      return { ok: false as const, error: String((error as Error)?.message ?? error) }
    }
  })

  /* ------------------------------------------------------------ 右键小卡片 */

  ipcMain.on(IPC.peekShow, () => {
    // 已经开着就收起来（右键 = 开关）
    if (peekVisible()) {
      hidePeek()
      return
    }
    void buildPeekData()
      .then((data) => showPeekWith(data))
      .catch((error) => logError('peek', error))
  })

  ipcMain.on(IPC.peekHide, () => hidePeek())

  /* ------------------------------------------------------------ 人格提示词 */

  ipcMain.handle(IPC.personaGet, async () => {
    try {
      return await getBridge().getPersona()
    } catch (error) {
      logError('personaGet', error)
      return { text: '', isDefault: true, error: String((error as Error)?.message ?? error) }
    }
  })

  ipcMain.handle(IPC.personaSave, async (_event, raw: unknown) => {
    const parsed = z.string().max(200_000).safeParse(raw)
    if (!parsed.success) return { ok: false as const, error: '内容太长或格式不对' }
    try {
      const result = await getBridge().savePersona(parsed.data)
      logInfo('persona', 'saved ' + parsed.data.length + ' chars')
      return { ok: true as const, ...result }
    } catch (error) {
      logError('personaSave', error)
      return { ok: false as const, error: String((error as Error)?.message ?? error) }
    }
  })

  ipcMain.handle(IPC.personaReset, async () => {
    try {
      const result = await getBridge().resetPersona()
      logInfo('persona', 'reset to default')
      return { ok: true as const, ...result }
    } catch (error) {
      logError('personaReset', error)
      return { ok: false as const, error: String((error as Error)?.message ?? error) }
    }
  })
}
