/**
 * 麦克风采集。跑在音频线程上，把设备采样率降到 16 kHz、切成 100ms 的 Int16 再交回主线程。
 * 替代 ScriptProcessorNode（主线程回调，会和界面抢时间）。
 */
class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.pending = new Float32Array(0)
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0]
    if (!input || input.length === 0) return true

    const rate = sampleRate
    const target = 16000
    let resampled
    if (rate === target) {
      resampled = input
    } else {
      const ratio = rate / target
      const length = Math.floor(input.length / ratio)
      resampled = new Float32Array(length)
      for (let i = 0; i < length; i++) {
        const pos = i * ratio
        const base = Math.floor(pos)
        const frac = pos - base
        const a = input[base] || 0
        const b = input[base + 1] || a
        resampled[i] = a + (b - a) * frac
      }
    }

    const merged = new Float32Array(this.pending.length + resampled.length)
    merged.set(this.pending, 0)
    merged.set(resampled, this.pending.length)
    const usable = Math.floor(merged.length / 1600) * 1600
    if (usable === 0) {
      this.pending = merged
      return true
    }
    this.pending = merged.slice(usable)
    const slice = merged.subarray(0, usable)
    const pcm = new Int16Array(slice.length)
    for (let i = 0; i < slice.length; i++) {
      const sample = Math.max(-1, Math.min(1, slice[i]))
      pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
    }
    this.port.postMessage(pcm.buffer, [pcm.buffer])
    return true
  }
}

registerProcessor('mic-processor', MicProcessor)
