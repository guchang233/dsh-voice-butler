/**
 * 语音合成：两家。
 *
 *   DeepSeek   POST {baseUrl}/v1/tools/tts → 24 kHz / mono / s16le 裸 PCM 流
 *   阿里云百炼  POST /api/v1/services/aigc/multimodal-generation/generation
 *              （qwen3-tts-flash，response_format=wav → 返回音频 URL）
 *              下载到的 WAV 实测是 24 kHz / mono / 16 bit，和 DeepSeek 同规格，
 *              剥掉 44 字节头就是 PCM，直接走同一条播放管线。
 */

import type { TtsProvider } from '../../shared/ipc'

export const TTS_SAMPLE_RATE = 24000

const DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com'
const TTS_TIMEOUT_MS = 45_000

export type TtsConfig = {
  provider: TtsProvider
  baseUrl: string
  apiKey: string
  voice: string
  model: string
}

type Sink = (pcm: Uint8Array) => void

/** 把流式正文切成一句一句，句子边界才起播（原实现，不能丢） */
export class SentenceChunker {
  private buffer = ''

  constructor(
    private readonly min = 8,
    private readonly max = 42,
  ) {}

  push(delta: string): string[] {
    this.buffer += delta
    const out: string[] = []
    for (;;) {
      const chars = [...this.buffer]
      const index = chars.findIndex((ch) => '。！？；!?;\n'.includes(ch))
      if (index >= this.min) {
        const sentence = chars.slice(0, index + 1).join('')
        this.buffer = chars.slice(index + 1).join('')
        out.push(sentence)
        continue
      }
      if (chars.length >= this.max) {
        const sentence = chars.slice(0, this.max).join('')
        this.buffer = chars.slice(this.max).join('')
        out.push(sentence)
        continue
      }
      break
    }
    return out
  }

  /** 收尾：把剩下的倒出来（原契约：返回字符串） */
  flush(): string | null {
    const rest = this.buffer.trim()
    this.buffer = ''
    return rest ? rest : null
  }
}

export class TtsQueue {
  private chain: Promise<void> = Promise.resolve()
  private controller: AbortController
  /** 已下发的 PCM 字节数，用来估算播放时长 */
  bytesTotal = 0

  constructor(
    private readonly getConfig: () => TtsConfig,
    private readonly sink: Sink,
    private readonly onError: (error: unknown) => void,
    private readonly onLevel?: (busy: boolean) => void,
  ) {
    this.controller = new AbortController()
  }

  /** 排队念一句；前一句没念完不会抢麦 */
  say(text: string): void {
    const cleaned = text.trim()
    if (!cleaned) return
    this.chain = this.chain
      .then(() => this.run(cleaned))
      .catch((error) => {
        // stop() 主动中止的那次读流不算错误
        if ((error as { name?: string })?.name === 'AbortError') return
        if (!this.controller.signal.aborted) this.onError(error)
      })
  }

  /** 等队列里的句子都合成完（不等于播放完） */
  whenIdle(): Promise<void> {
    return this.chain
  }

  stop(): void {
    this.controller.abort()
    this.controller = new AbortController()
    this.chain = Promise.resolve()
  }

  private async run(text: string): Promise<void> {
    const config = this.getConfig()
    if (!config.apiKey) throw new Error('还没配语音钥匙')
    this.onLevel?.(true)
    try {
      if (config.provider === 'dashscope') await this.sayDashScope(text, config)
      else await this.sayDeepSeek(text, config)
    } finally {
      this.onLevel?.(false)
    }
  }

  /** 现有通道：边收边播 */
  private async sayDeepSeek(text: string, config: TtsConfig): Promise<void> {
    const res = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/v1/tools/tts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: config.voice }),
      signal: this.controller.signal,
    })
    if (!res.ok) throw new Error(await describe('DeepSeek', res))
    if (!res.body) {
      // 没有流式 body 时退回整块读取
      this.emit(new Uint8Array(await res.arrayBuffer()))
      return
    }
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) this.emit(value)
    }
  }

  /** 百炼：先要一个音频地址，下载 WAV，剥头后按块喂播放器 */
  private async sayDashScope(text: string, config: TtsConfig): Promise<void> {
    const res = await fetch(`${DASHSCOPE_BASE}/api/v1/services/aigc/multimodal-generation/generation`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model || 'qwen3-tts-flash',
        input: { text, voice: config.voice || 'Cherry' },
        parameters: { response_format: 'wav' },
      }),
      signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(await describe('阿里云百炼', res))
    const body = (await res.json()) as { output?: { audio?: { url?: string } } }
    const url = body.output?.audio?.url
    if (!url) throw new Error('百炼没有返回音频地址')

    const audio = await fetch(url, { signal: AbortSignal.timeout(TTS_TIMEOUT_MS) })
    if (!audio.ok) throw new Error(`下载百炼音频失败（HTTP ${audio.status}）`)
    const bytes = new Uint8Array(await audio.arrayBuffer())
    const pcm = stripWav(bytes)
    // 分成小块下发，播放器那边看起来跟流式一样
    const step = 8192
    for (let offset = 0; offset < pcm.length; offset += step) {
      this.emit(pcm.subarray(offset, Math.min(offset + step, pcm.length)))
      await new Promise((resolve) => setTimeout(resolve, 8))
    }
  }

  private emit(chunk: Uint8Array): void {
    if (chunk.length === 0) return
    this.bytesTotal += chunk.length
    this.sink(chunk)
  }
}

/** 从 WAV 里找出 data 段的负载；不是 WAV 就原样返回 */
export function stripWav(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 44) return bytes
  const riff = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!)
  const wave = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!)
  if (riff !== 'RIFF' || wave !== 'WAVE') return bytes
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!)
    const size = view.getUint32(offset + 4, true)
    if (id === 'data') {
      const start = offset + 8
      return bytes.subarray(start, Math.min(start + size, bytes.length))
    }
    offset += 8 + size + (size % 2)
  }
  return bytes.subarray(44)
}

async function describe(who: string, res: Response): Promise<string> {
  let detail = ''
  try {
    detail = await res.text()
  } catch {
    detail = ''
  }
  try {
    const body = JSON.parse(detail) as { message?: string; error?: { message?: string } }
    detail = body.error?.message || body.message || detail
  } catch {
    // 保留原文
  }
  detail = detail.replace(/\s+/g, ' ').trim().slice(0, 160)
  const map: Record<number, string> = {
    400: '这段文本服务端没法合成（400）',
    401: `${who} API Key 无效（401）`,
    402: '账户余额不足（402）',
    403: '没有使用该音色/模型的权限（403）',
    429: '请求过于频繁（429）',
  }
  const head = map[res.status] ?? `${who} 合成失败（HTTP ${res.status}）`
  return detail ? `${head}：${detail}` : head
}
