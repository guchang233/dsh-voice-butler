/**
 * 非流式 ASR 的伪流式包装（LocalAgreement-2）。
 *
 * 思路照搬 https://github.com/ufal/whisper_streaming ：音频按块增长，每隔约 1 秒
 * 把当前整段再送一次**非流式** ASR，只提交「最近两次结果的最长公共前缀」——
 * 不稳定的尾巴只显示、不提交。句子结束时再整段重识别一次，那才是权威结果。
 *
 * 和原版的差别：硅基流动 / 智谱的转写只回整段文本，既没有词级时间戳也没有 prompt，
 * 所以不做窗口裁剪，每次重识别整段（一轮语音有上限，代价可控）。
 */

import { encodeWavFromInt16, SAMPLE_RATE } from '../audio/vad'
import { WAKE_WORD } from '../../shared/ipc'

/** 每攒够这么久的新音频才值得再打一次非流式识别 */
export const MIN_CHUNK_MS = 1000

/** 单次识别出错后的冷却：免费接口被 429 时，不要一秒一次地撞 */
const ERROR_BACKOFF_MS = 1500

const WAKE_HEADS = [WAKE_WORD, '大飞鱼', '大肥于', '打肥鱼', '大非鱼']

export type AsrShown = { committed: string; partial: string }
export type TranscribeFn = (wav: Buffer) => Promise<string>

type Kind = 'latin' | 'cjk' | 'other'

function kindOf(ch: string): Kind {
  if (/[A-Za-z0-9]/.test(ch)) return 'latin'
  if (/[\u4e00-\u9fff]/.test(ch)) return 'cjk'
  return 'other'
}

export function tokenize(text: string): string[] {
  const tokens: string[] = []
  const re = /[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?|[\u4e00-\u9fff]|[^\s]/g
  let match: RegExpExecArray | null
  const source = text.replace(/\s+/g, ' ').trim()
  while ((match = re.exec(source))) tokens.push(match[0])
  return tokens
}

export function detokenize(tokens: string[]): string {
  let out = ''
  for (const token of tokens) {
    if (!out) {
      out = token
      continue
    }
    const prev = kindOf(out.at(-1) ?? '')
    const next = kindOf(token[0] ?? '')
    const gap =
      (prev === 'latin' && next === 'latin') ||
      (prev === 'latin' && next === 'cjk') ||
      (prev === 'cjk' && next === 'latin')
    out += gap ? ` ${token}` : token
  }
  return out
}

/** 只去掉开头的唤醒词。命令里后头再提到它，会留下来。 */
export function stripLeadingWake(text: string): string {
  let rest = text.trim()
  for (const head of WAKE_HEADS) {
    if (!head || !rest.startsWith(head)) continue
    rest = rest.slice(head.length).replace(/^[，,。.!！？?\s]+/, '').trim()
    break
  }
  return rest
}

/** 显示用：把已经念出来的唤醒词从字幕里去掉，但不动后面的字 */
export function present(committed: string, partial: string): AsrShown {
  const full = committed + partial
  const stripped = stripLeadingWake(full)
  const cut = full.length - stripped.length
  if (cut <= 0) return { committed, partial }
  if (cut >= committed.length) return { committed: '', partial: stripped }
  return { committed: committed.slice(cut), partial }
}

/**
 * whisper_streaming.HypothesisBuffer.flush 的文本版：
 * 两次完整识别的最长公共前缀一旦变长就冻结，之后不再改写。
 */
export class HypothesisBuffer {
  committed: string[] = []
  private previous: string[] | null = null

  insert(tokens: string[]): string[] {
    if (tokens.length === 0) return []
    const prev = this.previous
    this.previous = tokens.slice()
    if (!prev) return []

    let shared = 0
    const limit = Math.min(prev.length, tokens.length)
    while (shared < limit && prev[shared] === tokens[shared]) shared += 1
    if (shared <= this.committed.length) return []

    const added = prev.slice(this.committed.length, shared)
    this.committed = prev.slice(0, shared)
    return added
  }

  partial(): string[] {
    return (this.previous ?? []).slice(this.committed.length)
  }

  /** 收尾兜底：最后一次结果若仍以已提交前缀开头就整段采用，否则保留已提交的再接尾巴。 */
  finish(): string[] {
    const latest = this.previous ?? []
    let matched = 0
    while (
      matched < this.committed.length &&
      matched < latest.length &&
      this.committed[matched] === latest[matched]
    ) {
      matched += 1
    }
    if (matched === this.committed.length) return latest
    return this.committed.concat(latest.slice(this.committed.length))
  }

  reset(): void {
    this.committed = []
    this.previous = null
  }
}

export class OnlineAsr {
  private chunks: Int16Array[] = []
  private samples = 0
  private decodedSamples = 0
  private buffer = new HypothesisBuffer()
  private generation = 0
  private flying = false
  private chain: Promise<void> = Promise.resolve()
  private lastError: Error | null = null
  private lastKey = ''
  private heard = false
  private backoffUntil = 0
  private listener: ((shown: AsrShown) => void) | null = null

  constructor(private readonly transcribe: TranscribeFn) {}

  onUpdate(listener: (shown: AsrShown) => void): void {
    this.listener = listener
  }

  push(chunk: Int16Array): void {
    if (chunk.length === 0) return
    this.chunks.push(chunk)
    this.samples += chunk.length
  }

  durationMs(): number {
    return (this.samples / SAMPLE_RATE) * 1000
  }

  /**
   * 开口之前的静音不触发识别。从这一刻起再攒满一个 chunk 才打第一次 ASR，
   * 免得把「唤醒后干等」的空白一次次送上去。
   */
  markHeard(): void {
    if (this.heard) return
    this.heard = true
    this.decodedSamples = this.samples
  }

  /** 有足够多的新音频才值得再打一次 */
  ready(): boolean {
    if (!this.heard) return false
    if (Date.now() < this.backoffUntil) return false
    const pendingMs = ((this.samples - this.decodedSamples) / SAMPLE_RATE) * 1000
    return this.durationMs() >= MIN_CHUNK_MS && pendingMs >= MIN_CHUNK_MS
  }

  kick(): void {
    if (!this.ready() || this.flying) return
    this.chain = this.loop()
  }

  /** 等当前这一轮识别结束（测试与 finish 用） */
  idle(): Promise<void> {
    return this.chain
  }

  reset(): void {
    this.generation += 1
    this.chunks = []
    this.samples = 0
    this.decodedSamples = 0
    this.buffer.reset()
    this.lastError = null
    this.lastKey = ''
    this.heard = false
    this.backoffUntil = 0
  }

  async finish(): Promise<string> {
    const generation = this.generation
    await this.chain
    while (this.flying && generation === this.generation) await this.chain
    if (generation !== this.generation) return ''

    let finalText = ''
    if (this.samples >= SAMPLE_RATE * 0.3) {
      this.decodedSamples = this.samples
      try {
        const text = await this.transcribe(encodeWavFromInt16(this.chunks))
        if (generation !== this.generation) return ''
        this.lastError = null
        this.buffer.insert(tokenize(text))
        finalText = text
      } catch (error) {
        if (generation !== this.generation) return ''
        this.lastError = error instanceof Error ? error : new Error(String(error))
      }
    }

    /*
     * 收尾用「整段重识别」的结果，不用 buffer 拼出来的。
     * buffer.finish() 的策略是「已经显示出去的前缀不能改」，那是给实时字幕用的；
     * 这里要交给 DSH 执行的是一句命令，模型中途改口时硬拼前缀会得到半截重复的句子。
     */
    const spoken = finalText
      ? stripLeadingWake(finalText)
      : stripLeadingWake(detokenize(this.buffer.finish()))
    if (!spoken && this.lastError) throw this.lastError
    return spoken
  }

  private async loop(): Promise<void> {
    if (this.flying) return
    this.flying = true
    try {
      for (;;) {
        const generation = this.generation
        if (!this.ready()) break
        this.decodedSamples = this.samples
        const wav = encodeWavFromInt16(this.chunks)
        try {
          const text = await this.transcribe(wav)
          if (generation !== this.generation) continue
          this.lastError = null
          this.buffer.insert(tokenize(text))
          this.emit()
        } catch (error) {
          if (generation !== this.generation) continue
          this.lastError = error instanceof Error ? error : new Error(String(error))
          this.backoffUntil = Date.now() + ERROR_BACKOFF_MS
        }
      }
    } finally {
      this.flying = false
      if (this.ready()) this.chain = this.loop()
    }
  }

  private emit(): void {
    const committed = detokenize(this.buffer.committed)
    const partialTokens = this.buffer.partial()
    const full = detokenize([...this.buffer.committed, ...partialTokens])
    const rest = full.startsWith(committed) ? full.slice(committed.length) : detokenize(partialTokens)
    const shown = present(committed, rest)
    const key = `${shown.committed}\n${shown.partial}`
    if (key === this.lastKey) return
    this.lastKey = key
    this.listener?.(shown)
  }
}
