import { createEndpointer, encodeWavFromInt16, rms, SAMPLE_RATE } from './audio/vad'
import { createKeywordWatcher, WAKE_WORD_TEXT, type KeywordWatcher } from './audio/kws'
import { getBridge } from './bridge'
import { logError, logInfo } from './log'
import { overlaySetState, overlayToolEnd, overlayToolStart } from './overlay'
import { transcribe } from './speech/asr'
import { SentenceChunker, TtsQueue, TTS_SAMPLE_RATE } from './speech/tts'
import { getApiKey, getSettings } from './store'
import { getBall, getPanel, showPanel } from './windows'
import { IPC, type LinkState, type VoiceFrame, type VoiceState } from '../shared/ipc'

/**
 * 语音层：这一层只负责「听」和「说」。
 *
 *   idle ──唤醒词/按键──► listening ──静音──► ASR ──文字──► DSH 管家会话
 *     ▲                                                    │
 *     └──────── DSH 推回帧：念出来 + 铺到面板 ◄────────────┘
 *
 * 它不知道 DSH 里发生了什么、也不判断该不该做——那是管家会话的事。
 */

const PREROLL_MS = 700
const MIN_UTTERANCE_MS = 350
const MAX_UTTERANCE_MS = 15_000

const YES = /(可以|行|好|嗯|对|是|确认|同意|继续|放行|ok|yes|okay|开吧|关吧|删吧)/i
const NO = /(别|不|取消|算了|不要|停|等等|no)/i

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type Capture = {
  resolve: (text: string | null) => void
  timer: NodeJS.Timeout
}

export class Voice {
  private watcher: KeywordWatcher | null = null
  private endpointer = createEndpointer({ maxMs: MAX_UTTERANCE_MS })
  private state: VoiceState = 'idle'
  private preroll: Int16Array[] = []
  private prerollMs = 0
  private utterance: Int16Array[] = []
  private micEnabled = true
  private lastLevelSent = 0
  private micChunks = 0
  private micConfirmed = false
  private capture: Capture | null = null
  private chunker = new SentenceChunker()
  private tts: TtsQueue
  private startedSpeakingAt = 0
  private bargeIn = 0
  private spokenChars = 0
  private link: LinkState = 'connecting'
  private approval: { id: string; tool: string; reason: string } | null = null

  constructor() {
    this.tts = new TtsQueue(
      () => ({ baseUrl: getSettings().baseUrl, apiKey: getApiKey(), voice: getSettings().ttsVoice }),
      (pcm) =>
        this.send(IPC.speechChunk, pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength)),
      (error) => logError('tts', error)
    )
  }

  start(): void {
    this.watcher = createKeywordWatcher()
    this.micEnabled = getSettings().micEnabled
    this.broadcast()
    logInfo('voice', 'started, wake word = ' + WAKE_WORD_TEXT)
  }

  setMicEnabled(enabled: boolean): void {
    this.micEnabled = enabled
    if (!enabled) this.toIdle()
    logInfo('voice', 'mic = ' + String(enabled))
  }

  getState(): VoiceState {
    return this.state
  }

  /* --------------------------------------------------------------- 广播 */

  private send(channel: string, payload: unknown): void {
    for (const win of [getBall(), getPanel()]) {
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
    }
  }

  private broadcast(): void {
    this.send(IPC.voiceState, { state: this.state })
    overlaySetState(this.state)
  }

  private setState(next: VoiceState): void {
    if (this.state === next) return
    this.state = next
    this.broadcast()
  }

  private toIdle(): void {
    this.utterance = []
    this.endpointer.reset()
    if (this.capture) {
      const capture = this.capture
      this.capture = null
      clearTimeout(capture.timer)
      capture.resolve(null)
    }
    this.setState(this.link === 'offline' ? 'offline' : 'idle')
  }

  /* ---------------------------------------------------------- 采集主循环 */

  onChunk(chunk: Int16Array): void {
    if (!this.micEnabled) return

    if (!this.micConfirmed) {
      this.micChunks += 1
      if (this.micChunks % 30 === 0) {
        this.micConfirmed = true
        logInfo(
          'voice',
          `mic alive: ${this.micChunks} chunks, rms=${rms(chunk).toFixed(4)}, wake word=${
            this.watcher ? 'ready' : 'missing'
          }`
        )
      }
    }

    const now = Date.now()
    if (now - this.lastLevelSent > 90) {
      this.lastLevelSent = now
      this.send(IPC.micLevel, Math.min(1, rms(chunk) * 6))
    }

    if (this.state === 'listening' || this.state === 'confirming') {
      this.utterance.push(chunk)
      const result = this.endpointer.push(chunk)
      if (result.done) void this.finishUtterance(result.reason)
      return
    }

    if (this.state === 'speaking') {
      // 唤醒词永远可以打断：这条最可靠，也不会被自己的播放声骗到
      if (this.watcher) {
        const keyword = this.watcher.feed(chunk)
        if (keyword) {
          logInfo('voice', 'barge-in: 唤醒词「' + keyword + '」')
          this.bargeIn = 0
          this.triggerWake(keyword)
          return
        }
      }
      // 能量插话（默认关）：要求更响、更久，避免扬声器回声自触发
      if (getSettings().bargeIn && now - this.startedSpeakingAt > 600 && rms(chunk) > 0.12) {
        this.bargeIn += 1
        if (this.bargeIn >= 6) {
          logInfo('voice', 'barge-in: 用户插话了，停止播报')
          this.bargeIn = 0
          this.interruptForListen()
        }
      } else if (rms(chunk) < 0.03) {
        this.bargeIn = 0
      }
      return
    }

    if (this.state !== 'idle' && this.state !== 'offline') return

    this.pushPreroll(chunk)
    if (!this.watcher) return
    const keyword = this.watcher.feed(chunk)
    if (keyword) this.triggerWake(keyword)
  }

  private pushPreroll(chunk: Int16Array): void {
    this.preroll.push(chunk)
    this.prerollMs += (chunk.length / SAMPLE_RATE) * 1000
    while (this.prerollMs > PREROLL_MS && this.preroll.length > 1) {
      const dropped = this.preroll.shift()
      if (dropped) this.prerollMs -= (dropped.length / SAMPLE_RATE) * 1000
    }
  }

  private triggerWake(keyword: string): void {
    logInfo('voice', 'wake: ' + keyword)
    this.tts.stop()
    this.beginListening()
    this.send(IPC.wake, { text: keyword })
    showPanel()
  }

  private beginListening(): void {
    this.endpointer.reset()
    this.utterance = [...this.preroll]
    this.preroll = []
    this.prerollMs = 0
    this.setState('listening')
  }

  private interruptForListen(): void {
    this.tts.stop()
    this.startedSpeakingAt = 0
    this.beginListening()
  }

  /* ------------------------------------------------------------- 收尾 */

  private async finishUtterance(reason?: string): Promise<void> {
    const chunks = this.utterance
    const totalMs = (chunks.reduce((n, c) => n + c.length, 0) / SAMPLE_RATE) * 1000
    this.utterance = []
    this.endpointer.reset()

    const capture = this.capture

    if (totalMs < MIN_UTTERANCE_MS) {
      if (capture) {
        this.capture = null
        clearTimeout(capture.timer)
        this.setState('idle')
        capture.resolve(null)
        return
      }
      this.toIdle()
      return
    }

    this.setState('thinking')
    const settings = getSettings()
    const apiKey = getApiKey()
    if (!apiKey) {
      this.toIdle()
      this.send(IPC.voiceState, { state: 'error' })
      this.speakNow('还没配语音钥匙，打开面板填一下。')
      return
    }

    let text = ''
    try {
      const wav = encodeWavFromInt16(chunks)
      logInfo('voice', `utterance ${Math.round(totalMs)}ms reason=${reason ?? '-'} -> asr`)
      text = await transcribe(settings.baseUrl, apiKey, wav)
      logInfo('voice', 'asr: ' + text)
    } catch (error) {
      logError('asr', error)
      if (capture) {
        this.capture = null
        clearTimeout(capture.timer)
        this.setState('idle')
        capture.resolve(null)
        return
      }
      this.speakNow('语音识别出错了，我再说一次。')
      return
    }

    // 确认卡片的语音回答
    if (capture) {
      this.capture = null
      clearTimeout(capture.timer)
      this.setState('idle')
      capture.resolve(text || null)
      return
    }

    if (!text) {
      this.toIdle()
      return
    }

    await this.deliver(text)
  }

  /** 把一句话交给 DSH（打字和说话都走这里） */
  async deliver(text: string): Promise<void> {
    const clean = text.trim()
    if (!clean) return
    this.spokenChars = 0
    this.chunker = new SentenceChunker()
    try {
      await getBridge().say(clean)
      this.setState('thinking')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logError('deliver', message)
      this.speakNow('连不上 DSH，我这边只听到，脑子没在。')
      this.toIdle()
    }
  }

  /* ------------------------------------------------------------- DSH 的帧 */

  handleFrame(frame: VoiceFrame): void {
    // 面板那边自己显示，这里只管「要不要出声」
    switch (frame.t) {
      case 'delta': {
        if (!frame.text) return
        for (const sentence of this.chunker.push(frame.text)) this.speak(sentence)
        break
      }
      case 'reply': {
        const rest = this.chunker.flush()
        if (rest) this.speak(rest)
        // 整段跳过流式（比如工具后直接给结论）时，一次念完
        if (this.spokenChars === 0 && frame.text.trim()) this.speak(frame.text)
        this.scheduleIdle()
        break
      }
      case 'tool': {
        if (frame.phase === 'start') overlayToolStart()
        else overlayToolEnd()
        break
      }
      case 'approval': {
        this.approval = { id: frame.id, tool: frame.tool, reason: frame.reason }
        void this.askApproval(frame)
        break
      }
      case 'approval-done': {
        this.approval = null
        if (this.state === 'confirming') this.setState('speaking')
        break
      }
      case 'error': {
        logError('dsh', frame.message)
        break
      }
      case 'state': {
        if (!frame.running && this.state === 'thinking') this.scheduleIdle()
        break
      }
      default:
        break
    }
  }

  handleHistory(frames: VoiceFrame[]): void {
    // 补历史时不要念旧话，只让面板显示
    void frames
  }

  handleLink(link: LinkState): void {
    this.link = link
    if (link === 'offline') {
      if (['idle', 'thinking'].includes(this.state)) this.setState('offline')
      return
    }
    if (link === 'online' && this.state === 'offline') this.setState('idle')
  }

  /** DSH 弹确认时，先用嘴问一句，听到「可以」就放行；面板上也能点 */
  private async askApproval(frame: { id: string; tool: string; reason: string }): Promise<void> {
    const summary = frame.reason?.trim() || frame.tool
    this.setState('confirming')
    this.speak(`要${summary}，可以吗？`)
    const answer = await this.listenOnce(9000)
    if (this.approval?.id !== frame.id) return
    if (!answer) return
    if (NO.test(answer) && !YES.test(answer)) {
      this.approval = null
      void getBridge().approve(frame.id, false).catch((error) => logError('approve', error))
      return
    }
    if (YES.test(answer)) {
      this.approval = null
      void getBridge().approve(frame.id, true).catch((error) => logError('approve', error))
    }
  }

  /* -------------------------------------------------------------- 出声 */

  private speak(text: string): void {
    const clean = text.trim()
    if (!clean) return
    this.spokenChars += clean.length
    this.startedSpeakingAt = Date.now()
    this.setState('speaking')
    this.tts.say(clean)
  }

  /** 直接念一句（本地提示音性质的话，不进会话） */
  speakNow(text: string): void {
    this.spokenChars += text.length
    this.startedSpeakingAt = Date.now()
    this.setState('speaking')
    this.tts.say(text)
    this.scheduleIdle(2500)
  }

  private scheduleIdle(delay = 1200): void {
    setTimeout(() => {
      if (this.state === 'speaking' || this.state === 'thinking') this.toIdle()
    }, delay)
  }

  /* ---------------------------------------------------------- 录音/打断 */

  /** 录一段话并识别；超时返回 null */
  listenOnce(timeoutMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      this.endpointer.reset()
      this.utterance = []
      this.setState('confirming')
      const timer = setTimeout(() => {
        if (this.capture?.timer === timer) this.capture = null
        this.setState('idle')
        resolve(null)
      }, timeoutMs)
      this.capture = { resolve, timer }
    })
  }

  interrupt(): void {
    this.tts.stop()
    this.toIdle()
  }

  /** DSH 那一轮被打断 */
  interruptTurn(): void {
    void getBridge()
      .stopTurn()
      .catch((error) => logError('stopTurn', error))
    this.tts.stop()
    this.scheduleIdle(400)
  }

  /** 唤醒提示（面板按钮用） */
  wakeByHand(): void {
    this.triggerWake('按钮')
  }

  stopPlaybackOnly(): void {
    this.tts.stop()
  }
}

let instance: Voice | null = null

export function getVoice(): Voice {
  if (!instance) instance = new Voice()
  return instance
}

export { WAKE_WORD_TEXT }
export const TTS_RATE = TTS_SAMPLE_RATE
export { sleep }
