/** 球窗口里的音频：麦克风采集（16 kHz PCM 分片上行）+ TTS PCM 排程播放 + 唤醒提示音 */

const TARGET_RATE = 16000
const PLAY_RATE = 24000

let micCtx: AudioContext | null = null
let micNode: ScriptProcessorNode | null = null
let micStream: MediaStream | null = null
let micGain: GainNode | null = null

let playCtx: AudioContext | null = null
let nextTime = 0
/** 网络分片可能把一个 16-bit 采样切成两半，留到下一片再拼 */
let pcmRest = new Uint8Array(0)

/* ------------------------------------------------------------------ 播放 */

function ensurePlayCtx(): AudioContext {
  if (!playCtx) playCtx = new AudioContext({ sampleRate: PLAY_RATE })
  if (playCtx.state === 'suspended') void playCtx.resume()
  return playCtx
}

/** 裸 PCM（24 kHz / mono / s16le）分片，边收边排程 */
export function pushPcm(buffer: ArrayBuffer): void {
  const ctx = ensurePlayCtx()
  const chunk = new Uint8Array(buffer)
  const bytes = new Uint8Array(pcmRest.length + chunk.length)
  bytes.set(pcmRest)
  bytes.set(chunk, pcmRest.length)

  const count = bytes.length >> 1
  if (count === 0) {
    pcmRest = bytes
    return
  }
  pcmRest = bytes.slice(count * 2)

  const samples = new Float32Array(count)
  const view = new DataView(bytes.buffer, 0, count * 2)
  for (let i = 0; i < count; i++) samples[i] = view.getInt16(i * 2, true) / 32768

  const audioBuffer = ctx.createBuffer(1, samples.length, PLAY_RATE)
  audioBuffer.copyToChannel(samples, 0)
  const source = ctx.createBufferSource()
  source.buffer = audioBuffer
  source.connect(ctx.destination)

  const start = Math.max(ctx.currentTime + 0.02, nextTime)
  source.start(start)
  nextTime = start + audioBuffer.duration
}

export function stopPlayback(): void {
  pcmRest = new Uint8Array(0)
  if (!playCtx) return
  void playCtx.close()
  playCtx = null
  nextTime = 0
}

/* ------------------------------------------------------------------ 提示音 */

/** 唤醒 / 出错提示音，现场合成，不占资源文件 */
export function chime(kind: 'wake' | 'error' = 'wake'): void {
  const ctx = ensurePlayCtx()
  const now = ctx.currentTime
  const tones = kind === 'wake' ? [660, 990] : [440, 330]
  tones.forEach((freq, index) => {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq
    const at = now + index * 0.085
    gain.gain.setValueAtTime(0.0001, at)
    gain.gain.exponentialRampToValueAtTime(0.16, at + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.14)
    osc.connect(gain).connect(ctx.destination)
    osc.start(at)
    osc.stop(at + 0.16)
  })
}

/* ------------------------------------------------------------------ 采集 */

function downsample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input
  const ratio = from / to
  const length = Math.floor(input.length / ratio)
  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    const pos = i * ratio
    const base = Math.floor(pos)
    const frac = pos - base
    const a = input[base] ?? 0
    const b = input[base + 1] ?? a
    out[i] = a + (b - a) * frac
  }
  return out
}

function toInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out
}

export async function startMic(onChunk: (chunk: Int16Array) => void): Promise<boolean> {
  if (micNode) return true
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    })
    micCtx = new AudioContext()
    const rate = micCtx.sampleRate
    const source = micCtx.createMediaStreamSource(micStream)
    micNode = micCtx.createScriptProcessor(2048, 1, 1)
    micGain = micCtx.createGain()
    micGain.gain.value = 0 // 不把麦克风回放到扬声器，接个静音节点只为让 ScriptProcessor 持续回调

    let pending: Float32Array = new Float32Array(0)
    micNode.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0)
      const resampled = downsample(input, rate, TARGET_RATE)
      const merged = new Float32Array(pending.length + resampled.length)
      merged.set(pending)
      merged.set(resampled, pending.length)

      const usable = Math.floor(merged.length / 1600) * 1600
      if (usable === 0) {
        pending = merged
        return
      }
      pending = merged.slice(usable)
      onChunk(toInt16(merged.subarray(0, usable)))
    }

    source.connect(micNode)
    micNode.connect(micGain)
    micGain.connect(micCtx.destination)
    return true
  } catch (error) {
    console.warn('麦克风打开失败', error)
    return false
  }
}

export function stopMic(): void {
  micNode?.disconnect()
  micGain?.disconnect()
  micStream?.getTracks().forEach((track) => track.stop())
  void micCtx?.close()
  micNode = null
  micGain = null
  micStream = null
  micCtx = null
}
