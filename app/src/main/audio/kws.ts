import { app } from 'electron'
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
  acceptWaveform: (o: { sampleRate: number; samples: Float32Array }) => void
}

export function modelDir(): string {
  const root = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
  return join(root, 'models', 'kws')
}

export type KeywordWatcher = {
  feed: (samples: Int16Array) => string | null
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

/**
 * 本地离线唤醒词检测。模型是 zipformer transducer，解码端只允许 keywords.txt 里的那几串音。
 * 任何一步失败都返回 null —— 没有唤醒词也要能靠点鲸鱼用。
 *
 * 播报中要用的那个实例会把门限调低（扬声器声音盖住人声，标准门限经常打不着），
 * 代价是可能偶尔误触发——而误触发的后果只是「提前停嘴」，可以接受。
 */
export function createKeywordWatcher(options?: KeywordOptions): KeywordWatcher | null {
  const dir = modelDir()
  const files = {
    encoder: join(dir, 'encoder-epoch-12-avg-2-chunk-16-left-64.onnx'),
    decoder: join(dir, 'decoder-epoch-12-avg-2-chunk-16-left-64.onnx'),
    joiner: join(dir, 'joiner-epoch-12-avg-2-chunk-16-left-64.onnx'),
    tokens: join(dir, 'tokens.txt'),
    keywords: join(dir, 'keywords.txt')
  }
  for (const [key, file] of Object.entries(files)) {
    if (!existsSync(file)) {
      logError('kws', `模型文件缺失 ${key}: ${file}`)
      return null
    }
  }

  const score = options?.score ?? 2.0
  const threshold = options?.threshold ?? 0.25
  const label = options?.label ?? 'kws'

  try {
    const sherpa = requireCjs('sherpa-onnx-node')
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
    // 预热：先灌 500 ms 静音且**不 reset**。流式 transducer 开头没有静音垫底时，
    // 第一个音节的 token 会被吃掉（实测：不加垫底，「大肥鱼」整段念出来也命中不了）
    stream.acceptWaveform({ sampleRate: 16000, samples: new Float32Array(8000) })
    while (spotter.isReady(stream)) spotter.decode(stream)

    logInfo('kws', `${label} 就绪：${WAKE_WORD_TEXT}（score=${score} threshold=${threshold}）`)

    const reset = (): void => {
      try {
        spotter.reset(stream)
        // 重置会清掉缓冲区，补一段静音垫底，否则紧接着再喊一次会漏
        stream.acceptWaveform({ sampleRate: 16000, samples: new Float32Array(6400) })
        while (spotter.isReady(stream)) spotter.decode(stream)
      } catch {
        /* 重置失败无所谓 */
      }
    }

    return {
      keywordText: WAKE_WORD_TEXT,
      reset,
      feed(samples) {
        try {
          const floats = new Float32Array(samples.length)
          for (let i = 0; i < samples.length; i++) floats[i] = samples[i] / 32768
          stream.acceptWaveform({ sampleRate: 16000, samples: floats })
          while (spotter.isReady(stream)) spotter.decode(stream)
          const result = spotter.getResult(stream)
          if (result?.keyword) {
            reset()
            return result.keyword
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
          // 关闭时重置失败无所谓
        }
      }
    }
  } catch (error) {
    logError(`${label} 初始化失败`, error)
    return null
  }
}
