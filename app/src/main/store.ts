import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  WAKE_WORD,
  type Accent,
  type AsrProvider,
  type BallLevel,
  type EffectLevel,
  type SkinKey,
  type ThemeMode,
} from '../shared/ipc'

/**
 * 落盘结构。
 *
 * 注意这里**没有模型、没有对话设置**：想和做都在 DSH 里，这边只留语音要用的东西——
 * 识别与合成走 DeepSeek 的两个语音接口，所以只有一把 Key。
 * Key 用 safeStorage 加密后单独放一个字段，永不明文出现。
 */
type Stored = {
  v: 2
  apiKey?: string
  /** true = safeStorage 加密过的 base64；false = 系统不支持加密时的纯 base64 */
  enc?: boolean
  baseUrl: string
  ballPosition?: { x: number; y: number }
  micEnabled?: boolean
  ttsVoice?: 'stella' | 'tide'
  bargeIn?: boolean
  /** 连续对话：一轮说完直接接着听 */
  continuous?: boolean
  /** 贴图键：内置 whale / niang02，或导入的 user-xxxx */
  skin?: string
  /** 界面主题 */
  theme?: ThemeMode
  /** 强调色 */
  accent?: Accent
  /** 特效强度 */
  effect?: EffectLevel
  /** 悬浮球层级：最上层 / 普通置顶 / 不置顶 */
  ballLevel?: BallLevel
  /** 语音识别厂商 */
  asrProvider?: AsrProvider
  /** 各厂商的识别 Key（base64，enc 说明是否 safeStorage 加密过） */
  asrKeys?: Partial<Record<AsrProvider, { value: string; enc: boolean }>>
  /** 手动指定的 DSH 地址；留空则读 endpoint.json */
  dshOrigin?: string
}

const DEFAULTS: Stored = {
  v: 2,
  baseUrl: 'https://api.deepseek.com',
  micEnabled: true,
  ttsVoice: 'stella',
  bargeIn: false,
  continuous: false,
  skin: 'whale',
  theme: 'system',
  accent: 'none',
  effect: 'vivid',
  ballLevel: 'top',
  asrProvider: 'siliconflow',
}

/**
 * 皮肤键原来只认两张内置图，用户导入的 user-xxxx 一存就被改回 whale——
 * 这就是「能导入、但切换没反应」的根因。现在只做形状校验，具体存不存在交给渲染层兜底。
 */
function normalizeSkin(value: unknown): SkinKey {
  if (typeof value !== 'string') return 'whale'
  const key = value.trim()
  if (!key || key.length > 60) return 'whale'
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : 'whale'
}

function normalizeTheme(value: unknown): ThemeMode {
  return value === 'light' || value === 'dark' ? value : 'system'
}

/**
 * 识别厂商。
 *
 * `fallback` 是「没存过这个字段时该按谁算」：老用户手里只有 DeepSeek 钥匙，
 * 升级上来不能突然说「还没配识别 Key」——那种情况继续用 DeepSeek；新装才默认硅基流动。
 */
function normalizeAsrProvider(value: unknown, fallback: AsrProvider = 'siliconflow'): AsrProvider {
  if (value === 'siliconflow' || value === 'zhipu' || value === 'deepseek') return value
  return fallback
}

function normalizeAccent(value: unknown): Accent {
  return value === 'rose' || value === 'ocean' ? value : 'none'
}

function normalizeEffect(value: unknown): EffectLevel {
  return value === 'off' || value === 'soft' ? value : 'vivid'
}

function normalizeBallLevel(value: unknown): BallLevel {
  return value === 'float' || value === 'normal' ? value : 'top'
}

let cache: Stored | null = null

const settingsPath = (): string => join(app.getPath('userData'), 'settings.json')

function read(): Stored {
  if (cache) return cache
  const file = settingsPath()
  if (!existsSync(file)) {
    cache = { ...DEFAULTS }
    return cache
  }
  try {
    const raw = readFileSync(file, 'utf8')
    // 记事本 / PowerShell 5.1 写进来会带 BOM，JSON.parse 会直接抛——
    // 以前一抛就整份回落成默认值（钥匙、位置、层级全丢），这里先剥掉
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
    const parsed = JSON.parse(text) as Partial<Stored>
    cache = {
      ...DEFAULTS,
      apiKey: parsed.apiKey,
      enc: parsed.enc,
      baseUrl: (parsed.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, ''),
      ballPosition: parsed.ballPosition,
      micEnabled: parsed.micEnabled !== false,
      ttsVoice: parsed.ttsVoice === 'tide' ? 'tide' : 'stella',
      bargeIn: parsed.bargeIn === true,
      continuous: parsed.continuous === true,
      skin: normalizeSkin(parsed.skin),
      theme: normalizeTheme(parsed.theme),
      accent: normalizeAccent(parsed.accent),
      effect: normalizeEffect(parsed.effect),
      ballLevel: normalizeBallLevel(parsed.ballLevel),
      asrProvider: normalizeAsrProvider(parsed.asrProvider, parsed.apiKey ? 'deepseek' : 'siliconflow'),
      asrKeys: parsed.asrKeys,
      dshOrigin: typeof parsed.dshOrigin === 'string' ? parsed.dshOrigin : undefined,
    }
  } catch {
    // 文件损坏时用默认值继续，不阻塞启动
    cache = { ...DEFAULTS }
  }
  return cache
}

function write(next: Stored): void {
  cache = next
  const file = settingsPath()
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
  renameSync(tmp, file)
}

export type PublicLike = {
  hasKey: boolean
  asrProvider: AsrProvider
  hasAsrKey: boolean
  baseUrl: string
  ballPosition: { x: number; y: number } | null
  wakeWord: string
  micEnabled: boolean
  ttsVoice: 'stella' | 'tide'
  bargeIn: boolean
  continuous: boolean
  skin: SkinKey
  theme: ThemeMode
  accent: Accent
  effect: EffectLevel
  ballLevel: BallLevel
  dshOrigin: string
}

export function getSettings(): PublicLike {
  const s = read()
  return {
    hasKey: !!s.apiKey,
    asrProvider: normalizeAsrProvider(s.asrProvider),
    hasAsrKey: !!getAsrKey(),
    baseUrl: s.baseUrl,
    ballPosition: s.ballPosition ?? null,
    wakeWord: WAKE_WORD,
    micEnabled: s.micEnabled !== false,
    ttsVoice: s.ttsVoice === 'tide' ? 'tide' : 'stella',
    bargeIn: s.bargeIn === true,
    continuous: s.continuous === true,
    skin: normalizeSkin(s.skin),
    theme: normalizeTheme(s.theme),
    accent: normalizeAccent(s.accent),
    effect: normalizeEffect(s.effect),
    ballLevel: normalizeBallLevel(s.ballLevel),
    dshOrigin: s.dshOrigin ?? '',
  }
}

/** 解密后的明文 Key；只在主进程内使用 */
export function getApiKey(): string {
  const s = read()
  if (!s.apiKey) return ''
  try {
    const buf = Buffer.from(s.apiKey, 'base64')
    if (s.enc && safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(buf)
    }
    return buf.toString('utf8')
  } catch {
    return ''
  }
}

export function saveApiKey(key: string): void {
  const s = read()
  const trimmed = key.trim()
  if (!trimmed) {
    const next = { ...s }
    delete next.apiKey
    delete next.enc
    write({ ...next, v: 2 })
    return
  }
  if (safeStorage.isEncryptionAvailable()) {
    write({ ...s, apiKey: safeStorage.encryptString(trimmed).toString('base64'), enc: true })
  } else {
    write({ ...s, apiKey: Buffer.from(trimmed, 'utf8').toString('base64'), enc: false })
  }
}

/** 当前识别厂商的明文 Key（只在主进程内用） */
export function getAsrKey(): string {
  const s = read()
  const provider = normalizeAsrProvider(s.asrProvider)
  const sealed = s.asrKeys?.[provider]
  if (!sealed?.value) return ''
  try {
    const buf = Buffer.from(sealed.value, 'base64')
    if (sealed.enc && safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(buf)
    return buf.toString('utf8')
  } catch {
    return ''
  }
}

/** 给某个厂商存/清识别 Key；key 为空串就是清除 */
export function saveAsrKey(provider: AsrProvider, key: string): void {
  const s = read()
  const keys = { ...(s.asrKeys ?? {}) }
  const trimmed = key.trim()
  if (!trimmed) {
    delete keys[provider]
    write({ ...s, v: 2, asrKeys: keys })
    return
  }
  const sealed = safeStorage.isEncryptionAvailable()
    ? { value: safeStorage.encryptString(trimmed).toString('base64'), enc: true }
    : { value: Buffer.from(trimmed, 'utf8').toString('base64'), enc: false }
  keys[provider] = sealed
  write({ ...s, v: 2, asrKeys: keys })
}

export function savePreferences(patch: {
  asrProvider?: AsrProvider
  baseUrl?: string
  micEnabled?: boolean
  ttsVoice?: 'stella' | 'tide'
  bargeIn?: boolean
  continuous?: boolean
  skin?: SkinKey
  theme?: ThemeMode
  accent?: Accent
  effect?: EffectLevel
  ballLevel?: BallLevel
  dshOrigin?: string
}): void {
  const s = read()
  write({
    ...s,
    v: 2,
    baseUrl: (patch.baseUrl ?? s.baseUrl).replace(/\/+$/, ''),
    micEnabled: patch.micEnabled ?? s.micEnabled,
    ttsVoice: patch.ttsVoice ?? s.ttsVoice,
    bargeIn: patch.bargeIn ?? s.bargeIn,
    continuous: patch.continuous ?? s.continuous === true,
    skin: normalizeSkin(patch.skin ?? s.skin),
    theme: normalizeTheme(patch.theme ?? s.theme),
    accent: normalizeAccent(patch.accent ?? s.accent),
    effect: normalizeEffect(patch.effect ?? s.effect),
    ballLevel: normalizeBallLevel(patch.ballLevel ?? s.ballLevel),
    asrProvider: normalizeAsrProvider(patch.asrProvider ?? s.asrProvider),
    dshOrigin: patch.dshOrigin ?? s.dshOrigin,
  })
}

export function saveBallPosition(pos: { x: number; y: number }): void {
  const s = read()
  write({ ...s, ballPosition: pos })
}
