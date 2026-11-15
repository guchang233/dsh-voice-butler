import workletUrl from './mic-processor.js?url'

/** 球窗口里的音频：麦克风采集（16 kHz PCM 分片上行）+ TTS PCM 排程播放 + 唤醒提示音 */

const PLAY_RATE = 24000

let micCtx: AudioContext | null = null
let micNode: AudioWorkletNode | null = null
let micStream: MediaStream | null = null
let micGain: GainNode | null = null
/** 上一次真正收到麦克风回调的时刻：太久没有 = 采集管线死了，得重开 */
let micLastAt = 0
let micRestartTimer: ReturnType<typeof setTimeout> | null = null
let micRestartCount = 0
let micWatchdog: ReturnType<typeof setInterval> | null = null
let micChunkSink: ((chunk: Int16Array) => void) | null = null

let playCtx: AudioContext | null = null
let playCtxDefaultRate = false
let nextTime = 0
/** 网络分片可能把一个 16-bit 采样切成两半，留到下一片再拼 */
let pcmRest = new Uint8Array(0)
let chunksSeen = 0
let idleLogged = false
/** 播放排空了就回调一次（主进程靠它判断「真的说完了」） */
let idleTimer: ReturnType<typeof setTimeout> | null = null
let idleListener: (() => void) | null = null
/**
 * 预计播完的墙钟时刻。
 *
 * 不用 AudioContext.currentTime 推：那个时钟在设备切换 / 上下文被挂起时会停走，
 * 于是「还剩 0.5 秒」永远到不了，回报晚十几秒都算好的（实测晚 30 秒）。
 * 播放本身是实时的，用 Date.now() 累加每片时长就够了。
 */
let playbackEndsAt = 0

export function setPlaybackIdleListener(listener: (() => void) | null): void {
  idleListener = listener
}

function armIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer)
  const wait = Math.max(120, playbackEndsAt - Date.now() + 200)
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (Date.now() < playbackEndsAt) {
      armIdleTimer()
      return
    }
    if (!idleLogged) {
      idleLogged = true
      console.error('[ball-audio] 播放排空，回报主进程（chunks=' + chunksSeen + '）')
    }
    idleListener?.()
  }, wait)
}

/* ------------------------------------------------------------------ 播放 */

function ensurePlayCtx(): AudioContext {
  // 音频设备换了 / 上下文废了（Chrome 会报 "AudioContext encountered an error"）：
  // 丢掉重开一个，下一片继续播，不要整场静音。
  if (playCtx && playCtx.state === 'closed') {
    playCtx = null
    nextTime = 0
  }
  if (!playCtx) {
    try {
      playCtx = new AudioContext({ sampleRate: PLAY_RATE })
      playCtxDefaultRate = false
    } catch (error) {
      // 有些声卡不认 24k，退回设备默认采样率（音源仍是 24k，浏览器会重采样）
      console.error('[ball-audio] 24k 上下文建不出来，退回默认采样率：', String(error))
      playCtx = new AudioContext()
      playCtxDefaultRate = true
    }
    playCtx.onstatechange = () => {
      if (!playCtx) return
      if (playCtx.state === 'suspended') void playCtx.resume()
      if (playCtx.state === 'closed') nextTime = 0
    }
  }
  if (playCtx.state === 'suspended') void playCtx.resume()
  return playCtx
}

/** 裸 PCM（24 kHz / mono / s16le）分片，边收边排程 */
export function pushPcm(buffer: ArrayBuffer): void {
  let ctx: AudioContext
  try {
    ctx = ensurePlayCtx()
  } catch (error) {
    console.error('[ball-audio] 音频上下文不可用，这一片丢掉：', String(error))
    return
  }
  if (chunksSeen === 0) console.error('[ball-audio] 第一片进播放器')
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

  try {
    const audioBuffer = ctx.createBuffer(1, samples.length, PLAY_RATE)
    audioBuffer.copyToChannel(samples, 0)
    const source = ctx.createBufferSource()
    source.buffer = audioBuffer
    source.connect(ctx.destination)

    const start = Math.max(ctx.currentTime + 0.02, nextTime)
    source.start(start)
    nextTime = start + audioBuffer.duration
    // 墙钟累计：这一片多长，播完时刻就往后推多久
    playbackEndsAt = Math.max(Date.now(), playbackEndsAt) + audioBuffer.duration * 1000
  } catch (error) {
    console.error('[ball-audio] 排程失败，重建上下文：', String(error))
    // 这一片救不回来了：重建上下文，下一片接着播（丢 ~85ms，比整段没了强）
    try {
      void playCtx?.close()
    } catch {
      /* ignore */
    }
    playCtx = null
    nextTime = 0
    return
  }

  chunksSeen += 1
  armIdleTimer()
}

export function stopPlayback(): void {
  pcmRest = new Uint8Array(0)
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  playbackEndsAt = 0
  if (!playCtx) {
    idleListener?.()
    return
  }
  void playCtx.close()
  playCtx = null
  nextTime = 0
  idleListener?.()
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

export async function startMic(onChunk: (chunk: Int16Array) => void): Promise<boolean> {
  micChunkSink = onChunk
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
    await micCtx.audioWorklet.addModule(workletUrl)
    const source = micCtx.createMediaStreamSource(micStream)
    micNode = new AudioWorkletNode(micCtx, 'mic-processor')
    micGain = micCtx.createGain()
    micGain.gain.value = 0
    micNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      micLastAt = Date.now()
      const pcm = new Int16Array(event.data)
      if (pcm.length) micChunkSink?.(pcm)
    }

    source.connect(micNode)
    micNode.connect(micGain)
    micGain.connect(micCtx.destination)
    micLastAt = Date.now()
    micRestartCount = 0

    // 设备换了 / 轨道断了：这台机器的音频栈确实会抽风，自己爬起来
    for (const track of micStream.getAudioTracks()) {
      track.addEventListener('ended', () => requestMicRestart('track ended'))
      track.addEventListener('mute', () => requestMicRestart('track muted'))
    }
    startMicWatchdog()
    return true
  } catch (error) {
    console.warn('麦克风打开失败', error)
    return false
  }
}

/** 重开采集：先关掉旧的，等 800ms 再开，避免和关设备打架 */
function requestMicRestart(reason: string): void {
  if (micRestartTimer) return
  if (micRestartCount > 6) return
  console.error('[ball-audio] 麦克风要重开：' + reason)
  micRestartTimer = setTimeout(() => {
    micRestartTimer = null
    micRestartCount += 1
    const sink = micChunkSink
    stopMic()
    if (sink) void startMic(sink)
  }, 800)
}

/** 外部（devicechange）要求重开采集 */
export function restartMic(): void {
  requestMicRestart('录音设备变化')
}

function startMicWatchdog(): void {  if (micWatchdog) return
  micWatchdog = setInterval(() => {
    // 回调停了 4 秒 = 采集管线死了（静音也会回调，所以「没回调」才是真死了）
    if (micLastAt && Date.now() - micLastAt > 4000) {
      micLastAt = Date.now()
      requestMicRestart('4 秒没有回调')
    }
  }, 2000)
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
