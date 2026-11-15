import { app, utilityProcess, type UtilityProcess } from 'electron'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { WAKE_WORD } from '../../shared/ipc'
import { logError, logInfo } from '../log'

const requireCjs = createRequire(__filename)

/** 唤醒词（模型按声母+韵母建模，关键词文件里必须写拼音 token） */
export const WAKE_WORD_TEXT = WAKE_WORD

type SpotterLike = {
  createStream: () => StreamLike
  isReady: (stream: StreamLike) => boolean
  decode: (stream: StreamLike) => void
  getResult: (stream: StreamLike) => { keyword?: string }
  reset: (stream: StreamLike) => void
}

type StreamLike = {
  acceptWaveform: (options: { sampleRate: number; samples: Float32Array }) => void
}

export function modelDir(): string {
  const root = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
  return join(root, 'models', 'kws')
}

export type KeywordWatcher = {
  feed: (samples: Int16Array) => string | null
  /** 自测把一整段音频同步塞完后，等子进程把命中回过来 */
  whenCaughtUp: (timeoutMs?: number) => Promise<string | null>
  reset: () => void
  close: () => void
  keywordText: string
}

export type KeywordOptions = {
  /** 越大越容易命中；关键词分数（默认 2.0） */
  score?: number
  /** 触发门限，越小越灵敏（默认 0.25） */
  threshold?: number
  /** 日志里区分用 */
  label?: string
}

const MODEL_FILES = [
  'encoder-epoch-12-avg-2-chunk-16-left-64.onnx',
  'decoder-epoch-12-avg-2-chunk-16-left-64.onnx',
  'joiner-epoch-12-avg-2-chunk-16-left-64.onnx',
  'tokens.txt',
  'keywords.txt'
] as const

function modelsReady(dir: string): boolean {
  for (const name of MODEL_FILES) {
    if (!existsSync(join(dir, name))) {
      logError('kws', `模型文件缺失 ${name}: ${join(dir, name)}`)
      return false
    }
  }
  return true
}

function workerScript(): string {
  return join(__dirname, 'kws-worker.js')
}

type Ack = { cmd: 'ack'; id: string; seq: number; keyword: string | null }
type Added = { cmd: 'added'; id: string }
type Failed = { cmd: 'error'; message: string }
type Alive = { cmd: 'alive' }

class RemoteWatcher {
  keywordText = WAKE_WORD_TEXT
  private seq = 0
  private acked = 0
  private hit: string | null = null
  private readonly queued: Array<{ seq: number; pcm: Uint8Array }> = []
  ready = false

  constructor(
    private readonly host: KwsHost,
    readonly id: string
  ) {}

  markReady(): void {
    this.ready = true
    const pending = this.queued.splice(0)
    for (const item of pending) this.host.postFeed(this.id, item.seq, item.pcm)
  }

  take(keyword: string | null): void {
    this.acked += 1
    if (keyword) this.hit = keyword
  }

  feed(samples: Int16Array): string | null {
    const found = this.hit
    this.hit = null
    this.seq += 1
    const pcm = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)
    if (!this.ready) this.queued.push({ seq: this.seq, pcm })
    else this.host.postFeed(this.id, this.seq, pcm)
    return found
  }

  whenCaughtUp(timeoutMs = 4000): Promise<string | null> {
    const target = this.seq
    const started = Date.now()
    return new Promise((resolve) => {
      const check = (): void => {
        if (this.acked >= target || Date.now() - started > timeoutMs) {
          const found = this.hit
          this.hit = null
          resolve(found)
          return
        }
        setTimeout(check, 15)
      }
      check()
    })
  }

  reset(): void {
    this.host.post({ cmd: 'reset', id: this.id })
  }

  close(): void {
    this.host.drop(this.id)
  }
}

class KwsHost {
  private child: UtilityProcess | null = null
  private readonly watchers = new Map<string, RemoteWatcher>()
  alive = false

  constructor(private readonly dir: string) {
    const script = workerScript()
    if (!existsSync(script)) throw new Error('找不到 kws-worker：' + script)
    this.child = utilityProcess.fork(script, [], { serviceName: 'butler-kws', stdio: 'pipe' })
    this.child.on('message', (message: unknown) => this.onMessage(message))
    this.child.on('exit', (code) => {
      logError('kws', '推理进程退出 ' + String(code))
      this.child = null
      this.alive = false
    })
    this.child.stderr?.on('data', (chunk: Buffer) => {
      const text = String(chunk).trim()
      if (text) logError('kws-worker', text)
    })
  }

  post(message: unknown): void {
    this.child?.postMessage(message)
  }

  postFeed(id: string, seq: number, pcm: Uint8Array): void {
    this.child?.postMessage({ cmd: 'feed', id, seq, pcm })
  }

  open(options?: KeywordOptions): KeywordWatcher {
    const id = `${options?.label ?? 'kws'}-${this.watchers.size + 1}`
    const watcher = new RemoteWatcher(this, id)
    this.watchers.set(id, watcher)
    const score = options?.score ?? 2.0
    const threshold = options?.threshold ?? 0.25
    this.post({ cmd: 'add', id, modelDir: this.dir, score, threshold })
    logInfo('kws', `${id} 交给推理进程（score=${score} threshold=${threshold}）`)
    return watcher
  }

  drop(id: string): void {
    this.watchers.delete(id)
  }

  private onMessage(message: unknown): void {
    const msg = message as Ack | Added | Failed | Alive
    if (!msg || typeof msg !== 'object' || !('cmd' in msg)) return
    if (msg.cmd === 'alive') {
      this.alive = true
      return
    }
    if (msg.cmd === 'error') {
      logError('kws-worker', msg.message)
      return
    }
    if (msg.cmd === 'added') {
      this.watchers.get(msg.id)?.markReady()
      return
    }
    if (msg.cmd === 'ack') this.watchers.get(msg.id)?.take(msg.keyword)
  }
}

let host: KwsHost | null = null
let hostFailed = false

/**
 * 本地离线唤醒词检测。推理在 utilityProcess 里；子进程起不来时退回主进程，免得完全听不见唤醒词。
 */
export function createKeywordWatcher(options?: KeywordOptions): KeywordWatcher | null {
  const dir = modelDir()
  if (!modelsReady(dir)) return null
  if (process.env['BUTLER_KWS_IN_PROCESS'] === '1') return createInlineWatcher(dir, options)
  if (!hostFailed) {
    try {
      if (!host) host = new KwsHost(dir)
      if (host) return host.open(options)
    } catch (error) {
      hostFailed = true
      logError('kws', '推理进程没起来，退回主进程', error)
    }
  }
  return createInlineWatcher(dir, options)
}

function createInlineWatcher(dir: string, options?: KeywordOptions): KeywordWatcher | null {
  const files = {
    encoder: join(dir, 'encoder-epoch-12-avg-2-chunk-16-left-64.onnx'),
    decoder: join(dir, 'decoder-epoch-12-avg-2-chunk-16-left-64.onnx'),
    joiner: join(dir, 'joiner-epoch-12-avg-2-chunk-16-left-64.onnx'),
    tokens: join(dir, 'tokens.txt'),
    keywords: join(dir, 'keywords.txt')
  }
  const score = options?.score ?? 2.0
  const threshold = options?.threshold ?? 0.25
  const label = options?.label ?? 'kws'
  try {
    const sherpa = requireCjs('sherpa-onnx-node') as {
      KeywordSpotter: new (config: unknown) => SpotterLike
    }
    const spotter: SpotterLike = new sherpa.KeywordSpotter({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        transducer: { encoder: files.encoder, decoder: files.decoder, joiner: files.joiner },
        tokens: files.tokens,
        numThreads: 1,
        provider: 'cpu',
        debug: 0
      },
      keywordsFile: files.keywords,
      keywordsScore: score,
      keywordsThreshold: threshold,
      maxActivePaths: 4,
      numTrailingBlanks: 2
    })
    const stream = spotter.createStream()
    stream.acceptWaveform({ sampleRate: 16000, samples: new Float32Array(8000) })
    while (spotter.isReady(stream)) spotter.decode(stream)
    logInfo('kws', `${label} 在主进程就绪：${WAKE_WORD_TEXT}（score=${score} threshold=${threshold}）`)

    let pending: string | null = null
    const reset = (): void => {
      try {
        spotter.reset(stream)
        stream.acceptWaveform({ sampleRate: 16000, samples: new Float32Array(6400) })
        while (spotter.isReady(stream)) spotter.decode(stream)
      } catch {
        /* 重置失败无所谓 */
      }
    }
    return {
      keywordText: WAKE_WORD_TEXT,
      reset,
      whenCaughtUp: () => Promise.resolve(pending),
      feed(samples) {
        try {
          const floats = new Float32Array(samples.length)
          for (let i = 0; i < samples.length; i++) floats[i] = samples[i] / 32768
          stream.acceptWaveform({ sampleRate: 16000, samples: floats })
          while (spotter.isReady(stream)) spotter.decode(stream)
          const result = spotter.getResult(stream)
          if (result?.keyword) {
            reset()
            pending = result.keyword
            const found = pending
            pending = null
            return found
          }
          return null
        } catch (error) {
          logError(`${label} feed`, error)
          return null
        }
      },
      close() {
        try {
          spotter.reset(stream)
        } catch {
          /* 关闭时重置失败无所谓 */
        }
      }
    }
  } catch (error) {
    logError(`${label} 初始化失败`, error)
    return null
  }
}
