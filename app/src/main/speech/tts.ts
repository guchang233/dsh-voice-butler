/** DeepSeek 语音合成：POST /v1/tools/tts，返回 24 kHz / mono / s16le 裸 PCM 流 */

export const TTS_SAMPLE_RATE = 24000
export type TtsVoice = 'stella' | 'tide'

type Sink = (pcm: Uint8Array) => void

export class TtsQueue {
  private chain: Promise<void> = Promise.resolve()
  private controller: AbortController
  /** 已下发的 PCM 字节数，用来估算播放时长 */
  bytesTotal = 0

  constructor(
    private readonly getConfig: () => { baseUrl: string; apiKey: string; voice: TtsVoice },
    private readonly sink: Sink,
    private readonly onError: (error: unknown) => void,
    private readonly onLevel?: (busy: boolean) => void
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
        if (!this.controller.signal.aborted) this.onError(error)
      })
  }

  /** 等队列里的句子都合成完（不等于播放完） */
  whenIdle(): Promise<void> {
    return this.chain
  }

  /** 打断：中止当前请求，队列里的后续句子一并作废 */
  stop(): void {
    this.controller.abort()
    this.controller = new AbortController()
    this.chain = Promise.resolve()
  }

  private async run(text: string): Promise<void> {
    const { baseUrl, apiKey, voice } = this.getConfig()
    if (!apiKey) return
    this.onLevel?.(true)

    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/tools/tts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text, voice_id: voice, format: 'pcm', filter_markdown: true }),
      signal: this.controller.signal
    })

    if (!res.ok || !res.body) {
      // 400 表示这句念不出来，跳过它继续下一句
      if (res.status === 400) return
      throw new Error(`语音合成失败（HTTP ${res.status}）`)
    }

    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && value.length) {
        this.bytesTotal += value.length
        this.sink(value)
      }
    }
    this.onLevel?.(false)
  }
}

/** 流式文本按句切开，逐句送合成 */
export class SentenceChunker {
  private buffer = ''

  constructor(
    private readonly min = 8,
    private readonly max = 42
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

  flush(): string | null {
    const rest = this.buffer.trim()
    this.buffer = ''
    return rest || null
  }
}
