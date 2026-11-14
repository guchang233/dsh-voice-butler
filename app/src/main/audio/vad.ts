/** 16 kHz 单声道 16-bit PCM 的端点检测与 WAV 封装 */

export const SAMPLE_RATE = 16000

/** 均方根，归一化到 0..1 */
export function rms(samples: Int16Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] / 32768
    sum += v * v
  }
  return Math.sqrt(sum / samples.length)
}

export type Endpointer = {
  push: (samples: Int16Array) => { done: boolean; reason?: 'silence' | 'timeout' }
  reset: () => void
  speechStarted: boolean
  elapsedMs: number
}

/**
 * 能量端点：低于阈值的连续时长超过 silenceMs 就收尾。
 * 阈值随噪声底自适应（噪声底 * 3，且不低于 minThreshold）。
 */
export function createEndpointer(options?: {
  silenceMs?: number
  minSpeechMs?: number
  maxMs?: number
  minThreshold?: number
}): Endpointer {
  const silenceMs = options?.silenceMs ?? 750
  const minSpeechMs = options?.minSpeechMs ?? 240
  const maxMs = options?.maxMs ?? 15000
  const minThreshold = options?.minThreshold ?? 0.012

  let noiseFloor = 0.004
  let silenceRun = 0
  let speechMs = 0
  let totalMs = 0
  let speechStarted = false

  return {
    get speechStarted() {
      return speechStarted
    },
    get elapsedMs() {
      return totalMs
    },
    reset() {
      noiseFloor = 0.004
      silenceRun = 0
      speechMs = 0
      totalMs = 0
      speechStarted = false
    },
    push(samples) {
      const chunkMs = (samples.length / SAMPLE_RATE) * 1000
      totalMs += chunkMs
      const level = rms(samples)

      if (!speechStarted) {
        // 前 400 ms 当作环境噪声采样
        if (totalMs < 400) noiseFloor = Math.min(noiseFloor * 0.8 + level * 0.2, 0.05)
        const threshold = Math.max(minThreshold, noiseFloor * 3)
        if (level > threshold) {
          speechMs += chunkMs
          if (speechMs >= minSpeechMs) speechStarted = true
        } else {
          speechMs = Math.max(0, speechMs - chunkMs * 0.5)
        }
      }

      if (speechStarted) {
        const threshold = Math.max(minThreshold, noiseFloor * 3)
        if (level < threshold) silenceRun += chunkMs
        else silenceRun = 0
        if (silenceRun >= silenceMs) return { done: true, reason: 'silence' }
      }

      if (totalMs >= maxMs) return { done: true, reason: 'timeout' }
      return { done: false }
    }
  }
}

/** Float32 分片 → WAV（16 kHz / mono / s16le） */
export function encodeWav(chunks: Float32Array[], sampleRate = SAMPLE_RATE): Buffer {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const buffer = Buffer.alloc(44 + total * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + total * 2, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(total * 2, 40)

  let offset = 44
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      const s = Math.max(-1, Math.min(1, chunk[i]))
      buffer.writeInt16LE(Math.round(s * 32767), offset)
      offset += 2
    }
  }
  return buffer
}

/** Int16 分片 → WAV */
export function encodeWavFromInt16(chunks: Int16Array[], sampleRate = SAMPLE_RATE): Buffer {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const buffer = Buffer.alloc(44 + total * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + total * 2, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(total * 2, 40)

  let offset = 44
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      buffer.writeInt16LE(chunk[i], offset)
      offset += 2
    }
  }
  return buffer
}
