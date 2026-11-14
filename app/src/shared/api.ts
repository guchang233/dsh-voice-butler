import type {
  LinkState,
  PublicSettings,
  Result,
  SettingsPatch,
  VoiceFrame,
  VoiceState,
  VoiceStatus
} from './ipc'

export type Unsubscribe = () => void

/** preload 通过 contextBridge 暴露到 window.api 的完整形状 */
export type ButlerApi = {
  getSettings: () => Promise<PublicSettings>
  saveSettings: (patch: SettingsPatch) => Promise<Result>
  verifyKey: (key: string) => Promise<Result>

  togglePanel: () => Promise<void>
  hidePanel: () => Promise<void>

  dragStart: () => void
  dragEnd: () => void

  /** 渲染层把麦克风 PCM 分片喂给主进程（唤醒词 + 端点检测） */
  feedAudio: (chunk: Int16Array) => void
  setMicEnabled: (enabled: boolean) => void

  /* 与 DSH 管家会话打交道 */
  say: (text: string) => Promise<Result>
  stop: () => Promise<Result>
  approve: (id: string, allow: boolean) => Promise<Result>
  newSession: () => Promise<Result>
  status: () => Promise<VoiceStatus>

  getSkin: () => Promise<string>
  setSkin: (skin: string) => Promise<string>
  onSkin: (fn: (skin: string) => void) => Unsubscribe
  getSkinCatalog: () => Promise<Array<{ key: string; label: string; url: string }>>
  importSkin: () => Promise<{ ok: boolean; key?: string; label?: string; error?: string }>
  removeSkin: (key: string) => Promise<boolean>
  renameSkin: (key: string, label: string) => Promise<{ ok: boolean; label?: string; error?: string }>
  onOverlay: (
    fn: (payload: { mode: 'off' | 'voice' | 'action'; phase: string; tools: number }) => void
  ) => Unsubscribe

  onPanelShown: (handler: () => void) => Unsubscribe
  onBallHover: (handler: (inside: boolean) => void) => Unsubscribe
  onVoiceState: (handler: (payload: { state: VoiceState }) => void) => Unsubscribe
  onLinkState: (handler: (payload: { link: LinkState; origin: string }) => void) => Unsubscribe
  onMicLevel: (handler: (level: number) => void) => Unsubscribe
  onWake: (handler: (payload: { text?: string }) => void) => Unsubscribe
  onSpeechChunk: (handler: (chunk: ArrayBuffer) => void) => Unsubscribe
  onSpeechEnd: (handler: () => void) => Unsubscribe
  /** 球窗播完最后一段音频后回 main：别再靠字数估时长了 */
  notifySpeechEnd: () => void
  /** main 要立刻静音（唤醒 / 插话 / 打断）时推给球窗 */
  onSpeechStop: (handler: () => void) => Unsubscribe
  onAsrText: (handler: (payload: { text: string }) => void) => Unsubscribe

  onFrame: (handler: (frame: VoiceFrame) => void) => Unsubscribe
  onHistory: (handler: (frames: VoiceFrame[]) => void) => Unsubscribe
  onReset: (handler: () => void) => Unsubscribe
}
