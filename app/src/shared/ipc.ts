/**
 * 主进程 / preload / 渲染进程 共用的契约。
 *
 * 这一版只做语音：唤醒 → 听 → 识别 → 交给 DSH 管家会话；把 DSH 的回话念出来、铺到面板上。
 * 对话逻辑、工具、确认闸门全在 DSH 里（插件 butler-bridge + 预设 管家模式）。
 */

/** 皮肤 = 悬浮球上那张贴图。内置两张，其余是用户导入的（键名形如 user-xxxx） */
export type SkinKey = 'whale' | 'niang02' | string

export const SKINS: Array<{ key: SkinKey; label: string }> = [
  { key: 'whale', label: '鲸鱼娘' },
  { key: 'niang02', label: '鲸鱼娘 · 02' },
]

/** 界面主题：跟随系统 / 纸（亮） / 墨（暗） */
export type ThemeMode = 'system' | 'light' | 'dark'

/** 强调色。纸/墨仍由主题决定；rose / ocean 是原来写在 data-skin 上、从没生效的两套 */
export type Accent = 'none' | 'rose' | 'ocean'

/** 顶层特效强度 */
export type EffectLevel = 'off' | 'soft' | 'vivid'

export const WAKE_WORD = '大肥鱼'

export const IPC = {
  settingsGet: 'settings:get',
  settingsSave: 'settings:save',
  settingsVerify: 'settings:verify',

  panelToggle: 'panel:toggle',
  panelHide: 'panel:hide',
  panelShown: 'panel:shown',

  ballDragStart: 'ball:drag-start',
  ballDragEnd: 'ball:drag-end',
  ballHover: 'ball:hover',

  /* 语音层 */
  audioFeed: 'audio:feed',
  micLevel: 'mic:level',
  micEnabled: 'mic:enabled',
  speechChunk: 'speech:chunk',
  speechEnd: 'speech:end',
  speechStop: 'speech:stop',
  /** 球窗 → main：最后一段音频真的播完了 */
  speechDrained: 'speech:drained',
  wake: 'voice:wake',
  asrText: 'asr:text',
  voiceState: 'butler:state',

  /* 与 DSH 的桥 */
  linkState: 'link:state',
  voiceSay: 'voice:say',
  asrPartial: 'asr:partial',
  secretsReveal: 'secrets:reveal',
  sessionsList: 'sessions:list',
  sessionSwitch: 'session:switch',
  modelsList: 'models:list',
  modelSelect: 'model:select',
  voiceStop: 'voice:stop',
  voiceApprove: 'voice:approve',
  voiceNew: 'voice:new',
  voiceStatus: 'voice:status',
  voiceFrame: 'voice:frame',
  voiceHistory: 'voice:history',
  voiceReset: 'voice:reset',

  /* 人格提示词 */
  personaGet: 'persona:get',
  personaSave: 'persona:save',
  personaReset: 'persona:reset',
  settingsChanged: 'settings:changed',
  voicePtt: 'voice:ptt',

  /* 右键小卡片：时段 + 余额 */
  peekShow: 'peek:show',
  peekHide: 'peek:hide',
  peekData: 'peek:data',

  /* 皮肤 */
  skinGet: 'skin:get',
  skinSet: 'skin:set',
  skinChanged: 'skin:changed',
  skinCatalog: 'skin:catalog',
  skinImport: 'skin:import',
  skinRemove: 'skin:remove',
  skinRename: 'skin:rename',

  overlayState: 'overlay:state',
} as const

/** 界面上那颗球/面板的状态 */
export type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'confirming' | 'offline' | 'error' | 'muted'

/** 和 DSH 的连接状态 */
export type LinkState = 'connecting' | 'online' | 'offline'

/**
 * DSH 发来的一帧。seq 单调递增，面板只追加不重排。
 * 字段与 butler-bridge 的帧一一对应。
 */
/** 工具调用在干什么：干活 / 动鼠标 */
export type ToolActivity = 'tool' | 'mouse'

export type VoiceFrame =
  | { seq: number; t: 'hello'; sessionId?: string; preset?: string | null; title?: string }
  | { seq: number; t: 'state'; running: boolean; phase: string }
  | { seq: number; t: 'user'; text: string; at?: number }
  | { seq: number; t: 'delta'; text: string }
  | { seq: number; t: 'reply'; text: string; at?: number; interrupted?: boolean }
  | {
      seq: number
      t: 'tool'
      phase: 'start' | 'end'
      id: string
      name: string
      args?: string
      ok?: boolean
      detail?: string
      /** 这次调用是在干活（tool）还是在动鼠标/敲键盘操作界面（mouse） */
      activity?: ToolActivity
    }
  | { seq: number; t: 'approval'; id: string; tool: string; reason: string }
  | { seq: number; t: 'approval-done'; id: string; outcome: string }
  | { seq: number; t: 'error'; message: string }
  | { seq: number; t: 'reset' }

/** 顶层特效：模式决定颜色，since 是进入该模式的时刻（开场动画用） */
export type OverlayMode = 'off' | 'wake' | 'think' | 'act' | 'mouse'

export type OverlayPayload = {
  mode: OverlayMode
  phase: string
  tools: number
  mouse: number
  since: number
  fx: EffectLevel
}

/** 悬浮球的窗口层级 */
export type BallLevel = 'top' | 'float' | 'normal'

export const BALL_LEVELS: Array<{ value: BallLevel; label: string; hint: string }> = [
  {
    value: 'top',
    label: '最上层',
    hint: '连别的置顶窗口也压得住（每秒抢一次最前），全屏应用也盖不住它',
  },
  { value: 'float', label: '普通置顶', hint: '默认。盖住普通窗口；遇到别的置顶窗口或全屏应用可能被压住' },
  { value: 'normal', label: '不置顶', hint: '和普通窗口一样，切到别的程序就会被挡住' },
]

/** 语音识别厂商：两家都有免费额度 */
export type AsrProvider = 'siliconflow' | 'zhipu' | 'dashscope' | 'deepseek'

/** 每家可选的具体模型；第一项是默认 */
export const ASR_MODELS: Record<AsrProvider, Array<{ id: string; label: string }>> = {
  siliconflow: [{ id: 'FunAudioLLM/SenseVoiceSmall', label: 'SenseVoiceSmall（免费）' }],
  zhipu: [
    { id: 'glm-asr-2512', label: 'GLM-ASR-2512（≤30 秒）' },
    { id: 'glm-asr', label: 'GLM-ASR（别名）' }
  ],
  dashscope: [
    { id: 'qwen3-asr-flash', label: 'Qwen3-ASR-Flash（推荐，≤5 分钟）' },
    { id: 'qwen-audio-3.0-asr-flash', label: 'Qwen-Audio-3.0-ASR-Flash' }
  ],
  deepseek: [{ id: 'default', label: '内置（跟语音钥匙共用）' }]
}

export const ASR_PROVIDERS: Array<{ value: AsrProvider; label: string; hint: string }> = [
  { value: 'siliconflow', label: '硅基流动', hint: 'SenseVoiceSmall，免费、国内直连' },
  { value: 'zhipu', label: '智谱', hint: 'GLM-ASR，免费额度，单段 ≤30 秒' },
  { value: 'dashscope', label: '阿里云百炼', hint: 'Qwen3-ASR-Flash，有免费额度，单段 ≤5 分钟' },
  { value: 'deepseek', label: 'DeepSeek', hint: '原来的通道，跟语音钥匙共用一把 Key' }
]

/** 边说边出的字幕（面板状态带上显示） */
export type AsrPartial = { committed: string; partial: string }

/** 面板打开时用来回填：明文只在主进程 ↔ 本应用页面之间走 */
export type RevealedSecrets = { apiKey: string; asrKey: string }

/* ---- 会话与模型（都来自 DSH，面板只做选择） ---- */
export type ButlerSession = {
  id: string
  cwd: string
  updatedAt: number
  running: boolean
  blank: boolean
  current: boolean
}

export type ButlerModel = {
  provider: string
  providerName: string
  id: string
  name: string
  description: string
  effort: string | null
  efforts: Array<{ id: string; name: string }>
}

export type ButlerModelCatalog = {
  models: ButlerModel[]
  current: { provider: string; model: string; effort: string | null } | null
  failures: Array<{ id: string; name: string; message: string }>
}

export type PublicSettings = {
  skin: SkinKey
  /** 界面主题（面板 / 悬浮球 / 顶层特效一起换） */
  theme: ThemeMode
  /** 强调色：默认 / 玫瑰 / 海 */
  accent: Accent
  /** 顶层特效：关 / 柔和 / 炫酷 */
  effect: EffectLevel
  /** 连续对话：一轮说完直接接着听，不用再喊唤醒词 */
  continuous: boolean
  /** 悬浮球的窗口层级 */
  ballLevel: BallLevel
  /** 语音识别厂商 */
  asrProvider: AsrProvider
  /** 当前厂商的识别 Key 配好了没 */
  hasAsrKey: boolean
  /** 当前厂商下选的具体模型 */
  asrModel: string
  /** 语音识别 / 合成用的 DeepSeek Key（对话不再用它） */
  hasKey: boolean
  baseUrl: string
  ballPosition: { x: number; y: number } | null
  wakeWord: string
  micEnabled: boolean
  ttsVoice: 'stella' | 'tide'
  bargeIn: boolean
  /** DSH 的那个管家会话 */
  sessionId: string | null
  sessionTitle: string
  dshOrigin: string
}

export type SettingsPatch = {
  apiKey?: string
  /** 识别厂商对应的 Key；空串表示清除 */
  asrApiKey?: string
  asrProvider?: AsrProvider
  asrModel?: string
  baseUrl?: string
  micEnabled?: boolean
  ttsVoice?: 'stella' | 'tide'
  bargeIn?: boolean
  dshOrigin?: string
  theme?: ThemeMode
  accent?: Accent
  effect?: EffectLevel
  continuous?: boolean
  ballLevel?: BallLevel
}

export type VoiceStatus = {
  link: LinkState
  state: VoiceState
  sessionId: string | null
  sessionTitle: string
  preset: string | null
  running: boolean
  origin: string
  lastError: string | null
}

/** DeepSeek 的峰谷时段（右键卡片用） */
export type PeekPricing = {
  peak: boolean
  label: string
  hint: string
  nextLabel: string
  nextAt: number
  remainMs: number
}

export type PeekBalance =
  | {
      ok: true
      currency: string
      total: string
      granted: string
      toppedUp: string
      available: boolean
    }
  | { ok: false; error: string }

export type PeekData = {
  at: number
  pricing: PeekPricing
  balance: PeekBalance
}

export type Result = { ok: true } | { ok: false; error: string }
