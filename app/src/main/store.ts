import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { WAKE_WORD, type SkinKey } from '../shared/ipc'

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
  skin?: SkinKey
  /** 手动指定的 DSH 地址；留空则读 endpoint.json */
  dshOrigin?: string
}

const DEFAULTS: Stored = {
  v: 2,
  baseUrl: 'https://api.deepseek.com',
  micEnabled: true,
  ttsVoice: 'stella',
  bargeIn: false,
  skin: 'whale'
}

const SKIN_KEYS: SkinKey[] = ['whale', 'niang02']

function normalizeSkin(value: unknown): SkinKey {
  return SKIN_KEYS.includes(value as SkinKey) ? (value as SkinKey) : 'whale'
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
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<Stored>
    cache = {
      ...DEFAULTS,
      apiKey: parsed.apiKey,
      enc: parsed.enc,
      baseUrl: (parsed.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, ''),
      ballPosition: parsed.ballPosition,
      micEnabled: parsed.micEnabled !== false,
      ttsVoice: parsed.ttsVoice === 'tide' ? 'tide' : 'stella',
      bargeIn: parsed.bargeIn === true,
      skin: normalizeSkin(parsed.skin),
      dshOrigin: typeof parsed.dshOrigin === 'string' ? parsed.dshOrigin : undefined
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
  baseUrl: string
  ballPosition: { x: number; y: number } | null
  wakeWord: string
  micEnabled: boolean
  ttsVoice: 'stella' | 'tide'
  bargeIn: boolean
  skin: SkinKey
  dshOrigin: string
}

export function getSettings(): PublicLike {
  const s = read()
  return {
    hasKey: !!s.apiKey,
    baseUrl: s.baseUrl,
    ballPosition: s.ballPosition ?? null,
    wakeWord: WAKE_WORD,
    micEnabled: s.micEnabled !== false,
    ttsVoice: s.ttsVoice === 'tide' ? 'tide' : 'stella',
    bargeIn: s.bargeIn === true,
    skin: normalizeSkin(s.skin),
    dshOrigin: s.dshOrigin ?? ''
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

export function savePreferences(patch: {
  baseUrl?: string
  micEnabled?: boolean
  ttsVoice?: 'stella' | 'tide'
  bargeIn?: boolean
  skin?: SkinKey
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
    skin: normalizeSkin(patch.skin ?? s.skin),
    dshOrigin: patch.dshOrigin ?? s.dshOrigin
  })
}

export function saveBallPosition(pos: { x: number; y: number }): void {
  const s = read()
  write({ ...s, ballPosition: pos })
}
