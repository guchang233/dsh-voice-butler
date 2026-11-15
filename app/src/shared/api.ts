import type {
  Accent,
  LinkState,
  OverlayPayload,
  PeekData,
  PublicSettings,
  Result,
  SettingsPatch,
  VoiceFrame,
  VoiceState,
  VoiceStatus
} from './ipc'

export type Unsubscribe = () => void

/** 主进程转过来的 MessagePort。两边的 tsconfig 对 MessagePort 不是同一个类型，所以这里只写用到的方法。 */
export type AudioHubPort = {
  start: () => void
  close: () => void
  postMessage: (message: unknown) => void
  onmessage: ((event: { data?: { bands?: number[] } }) => void) | null
}

/** 人格提示词的读取 / 保存结果 */
export type PersonaRead = { text: string; isDefault: boolean; error?: string }
export type PersonaWrite =
  | { ok: true; text: string; isDefault: boolean }
  | { ok: false; error: string }

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
  /** 按住说话：按下开始听，松开就结束这一句 */
  ptt: (down: boolean) => void
  /** 球窗口采到的频段，经 MessagePort 推给面板和特效层 */
  onAudioHub: (handler: (ports: AudioHubPort[]) => void) => Unsubscribe
  onSettings: (handler: (settings: PublicSettings) => void) => Unsubscribe

  /* 与 DSH 管家会话打交道 */
  say: (text: string) => Promise<Result>
  stop: () => Promise<Result>
  approve: (id: string, allow: boolean) => Promise<Result>
  newSession: () => Promise<Result>
  status: () => Promise<VoiceStatus>

  /* 人格提示词（存在 DSH 那边，改完下一句生效） */
  getPersona: () => Promise<PersonaRead>
  savePersona: (text: string) => Promise<PersonaWrite>
  resetPersona: () => Promise<PersonaWrite>

  /* 右键悬浮球：时段 + 余额小卡片 */
  showPeek: () => void
  hidePeek: () => void
  onPeekData: (handler: (data: PeekData) => void) => Unsubscribe

  getSkin: () => Promise<string>
  setSkin: (skin: string) => Promise<string>
  onSkin: (fn: (skin: string) => void) => Unsubscribe
  getSkinCatalog: () => Promise<Array<{ key: string; label: string; url: string }>>
  importSkin: () => Promise<{ ok: boolean; key?: string; label?: string; error?: string }>
  removeSkin: (key: string) => Promise<boolean>
  renameSkin: (key: string, label: string) => Promise<{ ok: boolean; label?: string; error?: string }>
  onOverlay: (fn: (payload: OverlayPayload) => void) => Unsubscribe

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
