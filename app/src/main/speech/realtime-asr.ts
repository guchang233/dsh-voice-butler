/**
 * 阿里云百炼的**真**流式识别：qwen3-asr-flash-realtime（WebSocket）。
 *
 * 为什么需要它：那套「伪装成流式」（LocalAgreement-2 反复调非流式接口）成立的前提是
 * 单次识别足够快——硅基流动 SenseVoice 约 150ms，百炼的 HTTP 一次性识别实测 4~7 秒，
 * 每次 partial 都压 4 秒，越积越晚，等于说完之后才出结果。百炼真正的流式在 WS 上。
 *
 * 协议（实测跑通）：
 *   连接 wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime
 *   → session.update { modalities:['text'], input_audio_format:'pcm', sample_rate:16000,
 *                      input_audio_transcription:{model}, turn_detection:null }
 *     （格式必须写 'pcm'，写 'pcm16' 会被服务端拒绝）
 *   → input_audio_buffer.append { audio: base64(PCM16 16k) }   ← 边说边发
 *   ← conversation.item.input_audio_transcription.text { transcript, stash? }  ← 增量
 *   → input_audio_buffer.commit
 *   ← conversation.item.input_audio_transcription.completed { transcript }     ← 终稿
 *
 * 断句交给我们自己的端点检测（turn_detection: null），不再叠一层服务端 VAD。
 */

import { SAMPLE_RATE } from '../audio/vad'

const REALTIME_URL =
  'wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime'

/** 收尾最多等这么久，超时就用已经拿到的那部分 */
const FINISH_TIMEOUT_MS = 6000
/** 连接超时：连不上就别让这一句卡住 */
const OPEN_TIMEOUT_MS = 4000

export type AsrShownUpdate = (shown: { committed: string; partial: string }) => void

type Options = {
  getKey: () => string
  onUpdate: AsrShownUpdate
  onError: (error: unknown) => void
}

export class RealtimeAsr {
  private socket: WebSocket | null = null
  private ready = false
  private opened: Promise<boolean> = Promise.resolve(false)
  private samples = 0
  private text = ''
  private queue: Int16Array[] = []
  private settled: ((text: string) => void) | null = null
  private generation = 0
  private lastShown = ''

  constructor(private readonly options: Options) {}

  durationMs(): number {
    return (this.samples / SAMPLE_RATE) * 1000
  }

  markHeard(): void {
    // 流式不需要「攒够再发」，这里只是接口对齐
  }

  kick(): void {
    if (!this.ready && !this.socket) void this.open()
  }

  push(chunk: Int16Array): void {
    if (chunk.length === 0) return
    this.samples += chunk.length
    if (!this.socket) {
      void this.open()
      return
    }
    if (!this.ready) {
      // 连上之前的音频先存着，连好了一起灌进去，别丢字
      this.queue.push(chunk)
      return
    }
    this.send(chunk)
  }

  reset(): void {
    this.generation += 1
    this.samples = 0
    this.text = ''
    this.queue = []
    this.lastShown = ''
    this.close()
  }

  /** 收尾：commit 之后等终稿 */
  async finish(): Promise<string> {
    const generation = this.generation
    await this.opened
    const socket = this.socket
    if (!socket || socket.readyState !== 1) {
      // 一条都没连上：把攒下的音频交给调用方去走别的路径
      return this.text.trim()
    }
    const done = new Promise<string>((resolve) => {
      this.settled = resolve
      setTimeout(() => resolve(this.text), FINISH_TIMEOUT_MS)
    })
    try {
      socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
    } catch (error) {
      this.options.onError(error)
      return this.text.trim()
    }
    const text = await done
    if (generation !== this.generation) return ''
    this.close()
    return text.trim()
  }

  /* ------------------------------------------------------------------ 内部 */

  private open(): Promise<boolean> {
    if (this.socket) return this.opened
    const key = this.options.getKey()
    if (!key) {
      this.options.onError(new Error('还没有配置百炼的识别 Key'))
      return Promise.resolve(false)
    }
    this.opened = new Promise<boolean>((resolve) => {
      let settled = false
      const finishOpen = (ok: boolean): void => {
        if (settled) return
        settled = true
        resolve(ok)
      }
      try {
        // Electron 主进程与 Node 20+ 都自带 WebSocket
        this.socket = new WebSocket(REALTIME_URL, { headers: { Authorization: `Bearer ${key}` } })
      } catch (error) {
        this.options.onError(error)
        finishOpen(false)
        return
      }

      const socket = this.socket
      const timer = setTimeout(() => {
        this.options.onError(new Error('百炼实时识别连不上（4 秒超时）'))
        finishOpen(false)
        this.close()
      }, OPEN_TIMEOUT_MS)

      socket.addEventListener('open', () => {
        socket.send(
          JSON.stringify({
            type: 'session.update',
            session: {
              modalities: ['text'],
              input_audio_format: 'pcm',
              sample_rate: SAMPLE_RATE,
              input_audio_transcription: { model: 'qwen3-asr-flash-realtime' },
              turn_detection: null
            }
          })
        )
        this.ready = true
        clearTimeout(timer)
        finishOpen(true)
        for (const chunk of this.queue) this.send(chunk)
        this.queue = []
      })

      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return
        let parsed: {
          type?: string
          transcript?: string
          delta?: string
          error?: { message?: string }
        }
        try {
          parsed = JSON.parse(event.data)
        } catch {
          return
        }
        const type = parsed.type ?? ''
        if (type === 'error') {
          this.options.onError(new Error(parsed.error?.message ?? '百炼实时识别报错'))
          return
        }
        if (type.includes('input_audio_transcription.text')) {
          const piece = parsed.transcript ?? parsed.delta ?? ''
          if (piece) {
            this.text = piece
            this.emit()
          }
          return
        }
        if (type.includes('input_audio_transcription.completed')) {
          if (parsed.transcript) {
            this.text = parsed.transcript
            this.emit()
          }
          this.settled?.(this.text)
          this.settled = null
        }
      })

      socket.addEventListener('error', () => {
        clearTimeout(timer)
        this.options.onError(new Error('百炼实时识别连接出错'))
        finishOpen(false)
      })

      socket.addEventListener('close', () => {
        this.ready = false
        this.socket = null
        finishOpen(false)
      })
    })
    return this.opened
  }

  private send(chunk: Int16Array): void {
    const socket = this.socket
    if (!socket || socket.readyState !== 1) return
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    try {
      socket.send(
        JSON.stringify({ type: 'input_audio_buffer.append', audio: bytes.toString('base64') })
      )
    } catch (error) {
      this.options.onError(error)
    }
  }

  private emit(): void {
    const text = this.text.trim()
    if (!text || text === this.lastShown) return
    this.lastShown = text
    this.options.onUpdate({ committed: '', partial: text })
  }

  private close(): void {
    this.ready = false
    const socket = this.socket
    this.socket = null
    if (!socket) return
    try {
      socket.close()
    } catch {
      // 已经断了就算了
    }
  }
}
