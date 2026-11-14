import { ipcMain } from 'electron'
import { z } from 'zod'
import { IPC } from '../shared/ipc'
import { getBridge } from './bridge'
import { importCustomSkin, listCustomSkins, removeCustomSkin } from './customSkins'
import { logError } from './log'
import { saveApiKey, savePreferences, getSettings } from './store'
import { getVoice } from './voice'
import { broadcastSkin, endDrag, hidePanel, startDrag, togglePanel } from './windows'

const settingsPatch = z.object({
  apiKey: z.string().max(400).optional(),
  baseUrl: z.string().max(300).optional(),
  micEnabled: z.boolean().optional(),
  ttsVoice: z.enum(['stella', 'tide']).optional(),
  bargeIn: z.boolean().optional(),
  dshOrigin: z.string().max(300).optional()
})

/** 只校验语音接口能不能用（GET /models，不花钱），不涉及对话 */
async function verifyKey(baseUrl: string, apiKey: string): Promise<void> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  })
  if (res.ok) return
  const map: Record<number, string> = {
    401: 'Key 无效（401）',
    402: '账户余额不足（402）',
    429: '请求过于频繁（429）'
  }
  throw new Error(map[res.status] ?? `校验失败（HTTP ${res.status}）`)
}

export function registerIpc(): void {
  ipcMain.handle(IPC.settingsGet, () => {
    const bridge = getBridge().status()
    return {
      ...getSettings(),
      sessionId: bridge.sessionId,
      sessionTitle: 'DSH语音管家'
    }
  })

  ipcMain.handle(IPC.settingsSave, async (_event, raw: unknown) => {
    const parsed = settingsPatch.safeParse(raw)
    if (!parsed.success) return { ok: false as const, error: '设置格式不正确' }
    const patch = parsed.data

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
      dshOrigin: patch.dshOrigin
    })
    if (patch.micEnabled !== undefined) getVoice().setMicEnabled(patch.micEnabled)
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
  ipcMain.handle(IPC.skinSet, (_e, skin: string) => {
    savePreferences({ skin: skin as never })
    const next = getSettings().skin
    broadcastSkin(next)
    return next
  })
  ipcMain.handle(IPC.skinCatalog, () => listCustomSkins())
  ipcMain.handle(IPC.skinImport, () => importCustomSkin())
  ipcMain.handle(IPC.skinRemove, (_e, key: unknown) => {
    const parsed = z.string().max(80).safeParse(key)
    return parsed.success ? removeCustomSkin(parsed.data) : false
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
      lastError: bridge.lastError
    }
  })
}
