/**
 * 唤醒词推理跑在 utilityProcess 里，避免堵住 Electron 主进程。
 * 模型路径和门限由主进程传进来；这里只负责喂音频、把命中回传。
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const requireCjs = createRequire(import.meta.url)

interface ParentPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): void
  postMessage(message: unknown): void
}

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

type Slot = {
  spotter: SpotterLike
  stream: StreamLike
  reset: () => void
}

type Inbound =
  | { cmd: 'add'; id: string; modelDir: string; score: number; threshold: number }
  | { cmd: 'feed'; id: string; seq: number; pcm: Uint8Array }
  | { cmd: 'reset'; id: string }
  | { cmd: 'close' }

function parentPort(): ParentPort {
  const port = (process as unknown as { parentPort?: ParentPort }).parentPort
  if (!port) throw new Error('kws-worker 只能在 utilityProcess 里跑')
  return port
}

function warm(spotter: SpotterLike, stream: StreamLike, samples: number): void {
  stream.acceptWaveform({ sampleRate: 16000, samples: new Float32Array(samples) })
  while (spotter.isReady(stream)) spotter.decode(stream)
}

function openSlot(modelDir: string, score: number, threshold: number): Slot {
  const files = {
    encoder: join(modelDir, 'encoder-epoch-12-avg-2-chunk-16-left-64.onnx'),
    decoder: join(modelDir, 'decoder-epoch-12-avg-2-chunk-16-left-64.onnx'),
    joiner: join(modelDir, 'joiner-epoch-12-avg-2-chunk-16-left-64.onnx'),
    tokens: join(modelDir, 'tokens.txt'),
    keywords: join(modelDir, 'keywords.txt'),
  }
  for (const file of Object.values(files)) {
    if (!existsSync(file)) throw new Error('模型文件缺失: ' + file)
  }
  const sherpa = requireCjs('sherpa-onnx-node') as {
    KeywordSpotter: new (config: unknown) => SpotterLike
  }
  const spotter = new sherpa.KeywordSpotter({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: files.encoder, decoder: files.decoder, joiner: files.joiner },
      tokens: files.tokens,
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
    },
    keywordsFile: files.keywords,
    keywordsScore: score,
    keywordsThreshold: threshold,
    maxActivePaths: 4,
    numTrailingBlanks: 2,
  })
  const stream = spotter.createStream()
  warm(spotter, stream, 8000)
  const reset = (): void => {
    try {
      spotter.reset(stream)
      warm(spotter, stream, 6400)
    } catch {
      /* 重置失败下一次喂音频再试 */
    }
  }
  return { spotter, stream, reset }
}

const slots = new Map<string, Slot>()
const port = parentPort()

port.on('message', (event) => {
  const msg = event.data as Inbound
  if (!msg || typeof msg !== 'object') return
  try {
    if (msg.cmd === 'add') {
      const slot = openSlot(msg.modelDir, msg.score, msg.threshold)
      slots.set(msg.id, slot)
      port.postMessage({ cmd: 'added', id: msg.id })
      return
    }
    if (msg.cmd === 'reset') {
      slots.get(msg.id)?.reset()
      return
    }
    if (msg.cmd === 'close') {
      slots.clear()
      return
    }
    if (msg.cmd !== 'feed') return
    const slot = slots.get(msg.id)
    if (!slot) {
      port.postMessage({ cmd: 'ack', id: msg.id, seq: msg.seq, keyword: null })
      return
    }
    const bytes = msg.pcm
    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2))
    const floats = new Float32Array(samples.length)
    for (let i = 0; i < samples.length; i++) floats[i] = samples[i] / 32768
    slot.stream.acceptWaveform({ sampleRate: 16000, samples: floats })
    while (slot.spotter.isReady(slot.stream)) slot.spotter.decode(slot.stream)
    const keyword = slot.spotter.getResult(slot.stream)?.keyword || null
    if (keyword) slot.reset()
    port.postMessage({ cmd: 'ack', id: msg.id, seq: msg.seq, keyword })
  } catch (error) {
    port.postMessage({ cmd: 'error', message: error instanceof Error ? error.message : String(error) })
  }
})

port.postMessage({ cmd: 'alive' })
