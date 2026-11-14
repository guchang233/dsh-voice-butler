import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IPC,
  type LinkState,
  type PublicSettings,
  type Result,
  type SettingsPatch,
  type VoiceFrame,
  type VoiceState,
  type VoiceStatus
} from '../shared/ipc'
import type { ButlerApi, PersonaRead, PersonaWrite, Unsubscribe } from '../shared/api'

function subscribe<T>(channel: string, handler: (payload: T) => void): Unsubscribe {
  const listener = (_event: IpcRendererEvent, payload: T): void => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.off(channel, listener)
}

const api: ButlerApi = {
  getSettings: (): Promise<PublicSettings> => ipcRenderer.invoke(IPC.settingsGet),
  saveSettings: (patch: SettingsPatch): Promise<Result> =>
    ipcRenderer.invoke(IPC.settingsSave, patch),
  verifyKey: (key: string): Promise<Result> => ipcRenderer.invoke(IPC.settingsVerify, key),

  togglePanel: (): Promise<void> => ipcRenderer.invoke(IPC.panelToggle),
  hidePanel: (): Promise<void> => ipcRenderer.invoke(IPC.panelHide),

  dragStart: (): void => ipcRenderer.send(IPC.ballDragStart),
  dragEnd: (): void => ipcRenderer.send(IPC.ballDragEnd),

  feedAudio: (chunk: Int16Array): void => ipcRenderer.send(IPC.audioFeed, chunk),
  setMicEnabled: (enabled: boolean): void => ipcRenderer.send(IPC.micEnabled, enabled),

  say: (text: string): Promise<Result> => ipcRenderer.invoke(IPC.voiceSay, text),
  stop: (): Promise<Result> => ipcRenderer.invoke(IPC.voiceStop),
  approve: (id: string, allow: boolean): Promise<Result> =>
    ipcRenderer.invoke(IPC.voiceApprove, { id, allow }),
  newSession: (): Promise<Result> => ipcRenderer.invoke(IPC.voiceNew),
  status: (): Promise<VoiceStatus> => ipcRenderer.invoke(IPC.voiceStatus),

  getPersona: (): Promise<PersonaRead> => ipcRenderer.invoke(IPC.personaGet),
  savePersona: (text: string): Promise<PersonaWrite> => ipcRenderer.invoke(IPC.personaSave, text),
  resetPersona: (): Promise<PersonaWrite> => ipcRenderer.invoke(IPC.personaReset),

  getSkin: (): Promise<string> => ipcRenderer.invoke(IPC.skinGet),
  setSkin: (skin: string): Promise<string> => ipcRenderer.invoke(IPC.skinSet, skin),
  onSkin: (fn: (skin: string) => void): Unsubscribe => {
    const handler = (_e: unknown, skin: string): void => fn(skin)
    ipcRenderer.on(IPC.skinChanged, handler)
    return () => ipcRenderer.removeListener(IPC.skinChanged, handler)
  },
  getSkinCatalog: (): Promise<Array<{ key: string; label: string; url: string }>> =>
    ipcRenderer.invoke(IPC.skinCatalog),
  importSkin: (): Promise<{ ok: boolean; key?: string; label?: string; error?: string }> =>
    ipcRenderer.invoke(IPC.skinImport),
  removeSkin: (key: string): Promise<boolean> => ipcRenderer.invoke(IPC.skinRemove, key),
  renameSkin: (key: string, label: string): Promise<{ ok: boolean; label?: string; error?: string }> =>
    ipcRenderer.invoke(IPC.skinRename, { key, label }),
  onOverlay: (
    fn: (payload: { mode: 'off' | 'voice' | 'action'; phase: string; tools: number }) => void
  ): Unsubscribe => {
    const handler = (
      _e: unknown,
      payload: { mode: 'off' | 'voice' | 'action'; phase: string; tools: number }
    ): void => fn(payload)
    ipcRenderer.on(IPC.overlayState, handler)
    return () => ipcRenderer.removeListener(IPC.overlayState, handler)
  },

  onPanelShown: (handler) => subscribe<null>(IPC.panelShown, () => handler()),
  onBallHover: (handler) => subscribe<boolean>(IPC.ballHover, handler),
  onVoiceState: (handler) => subscribe<{ state: VoiceState }>(IPC.voiceState, handler),
  onLinkState: (handler) =>
    subscribe<{ link: LinkState; origin: string }>(IPC.linkState, handler),
  onMicLevel: (handler) => subscribe<number>(IPC.micLevel, handler),
  onWake: (handler) => subscribe<{ text?: string }>(IPC.wake, handler),
  onSpeechChunk: (handler) => subscribe<ArrayBuffer>(IPC.speechChunk, handler),
  onSpeechEnd: (handler) => subscribe<null>(IPC.speechEnd, () => handler()),
  notifySpeechEnd: (): void => ipcRenderer.send(IPC.speechDrained),
  onSpeechStop: (handler) => subscribe<null>(IPC.speechStop, () => handler()),
  onAsrText: (handler) => subscribe<{ text: string }>(IPC.asrText, handler),

  onFrame: (handler) => subscribe<VoiceFrame>(IPC.voiceFrame, handler),
  onHistory: (handler) => subscribe<VoiceFrame[]>(IPC.voiceHistory, handler),
  onReset: (handler) => subscribe<null>(IPC.voiceReset, () => handler())
}

contextBridge.exposeInMainWorld('api', api)
