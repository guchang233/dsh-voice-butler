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
/** 连续对话里，静默这么久没人说话就退回去等唤醒词 */
const CONTINUOUS_IDLE_MS = 15_000

const YES = /(可以|行|好|嗯|对|是|确认|同意|继续|放行|ok|yes|okay|开吧|关吧|删吧)/i
const NO = /(别|不|取消|算了|不要|停|等等|no)/i

/** 「大肥鱼 / 大飞鱼」这类识别变体：打断时那句话开头常带着它 */
const WAKE_LEAD = /^\s*(大\s*[肥飞鲱非菲]\s*鱼|大肥鱼|大飞鱼)[\s，,。.、！!？?~～…]*/i

function stripWakeWord(text: string): string {
  return text.replace(WAKE_LEAD, '').trim()
}

/** 连续对话里的收尾话术：听到就结束这一轮对话，不用再喊唤醒词 */
const STOP_TALK = /(没事了|没事啦|没事|没有了|没了|先这样|就这样|不用了|不要了|拜拜|再见|退下|结束对话|够了|歇着吧)/

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type Capture = {
  resolve: (text: string | null) => void
  timer: NodeJS.Timeout
}

export class Voice {
  /** 待机时用的唤醒词引擎（标准灵敏度） */
  private watcher: KeywordWatcher | null = null
  /** 播报 / 思考时用的引擎：门限更低，方便一句话把管家打断 */
  private bargeWatcher: KeywordWatcher | null = null
  private endpointer = createEndpointer({ maxMs: MAX_UTTERANCE_MS })
  private state: VoiceState = 'idle'
  private preroll: Int16Array[] = []
  private prerollMs = 0
  private utterance: Int16Array[] = []
  private micEnabled = true
  private lastLevelSent = 0
  private lastLoudLoggedAt = 0
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
  /** 连续对话：一轮说完直接接着听 */
  private continuous = false
  private continueTimer: NodeJS.Timeout | null = null
  private listenDeadline: NodeJS.Timeout | null = null
  /** 这一轮连续收音最晚管到什么时候（没听清就重听，但不超过这个时刻） */
  private continuousArmedUntil = 0
  /** 球窗那边是不是已经播空了（靠 IPC 回报，不再用字数估时长） */
  private playbackIdle = true
  private drainWatchdog: NodeJS.Timeout | null = null
  /** 这一轮下发了多少片音频（诊断用） */
  private chunkCount = 0
  private lastChunkAt = 0
  /** 按已下发字节数推出来的「应该播完」的墙钟时刻 */
  private audioEndsAt = 0

  private runningTurn = false

  constructor() {
    this.tts = new TtsQueue(
      () => ({ baseUrl: getSettings().baseUrl, apiKey: getApiKey(), voice: getSettings().ttsVoice }),
      (pcm) => {
        this.chunkCount += 1
        this.lastChunkAt = Date.now()
        // 主进程自己算播放进度：球窗的定时器在后台会被 Chromium 节流，靠不住
        const durationMs = (pcm.byteLength / 2 / TTS_SAMPLE_RATE) * 1000
        this.audioEndsAt = Math.max(Date.now(), this.audioEndsAt) + durationMs
        if (this.chunkCount === 1) {
          logInfo('voice', `tts: 第一片音频 ${Math.round(durationMs)}ms → ball=${Boolean(getBall())}`)
        }
        this.send(IPC.speechChunk, pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength))
        this.scheduleDrainCheck()
      },
      (error) => logError('tts', error)
    )
  }

  start(): void {
    this.watcher = createKeywordWatcher({ label: 'kws' })
    // 播报时自己的声音会盖住人声，标准门限经常打不着——这里单独一个更灵敏的
    this.bargeWatcher = createKeywordWatcher({ score: 1.2, threshold: 0.12, label: 'kws-barge' })
    this.micEnabled = getSettings().micEnabled
    this.continuous = getSettings().continuous
    this.broadcast()
    logInfo('voice', 'started, wake word = ' + WAKE_WORD_TEXT + ', continuous = ' + this.continuous)
  }

  setMicEnabled(enabled: boolean): void {
    this.micEnabled = enabled
    if (!enabled) {
      this.cancelContinue()
      this.toIdle()
    }
    logInfo('voice', 'mic = ' + String(enabled))
  }

  /** 连续对话开关（设置里那个开关） */
  setContinuous(on: boolean): void {
    this.continuous = on
    if (!on) this.cancelContinue()
    logInfo('voice', 'continuous = ' + String(on))
  }

  isContinuous(): boolean {
    return this.continuous
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

    // 麦克风到底听不听得见：有声音就记一笔（5 秒最多一条），排查「喊了没反应」用
    const level = rms(chunk)
    if (level > 0.012 && now - this.lastLoudLoggedAt > 5000) {
      this.lastLoudLoggedAt = now
      logInfo('voice', `mic 有声：rms=${level.toFixed(3)}，当前状态 ${this.state}`)
    }

    if (this.state === 'listening') {
      // 已经在听的时候也认唤醒词：喊一声就当作「重新叫我」——
      // 否则连续对话一直在听，喊唤醒词既没响动也不弹面板，看起来就像坏了。
      const keyword = this.watcher?.feed(chunk) ?? null
      if (keyword) {
        logInfo('voice', 'listening 中又喊了唤醒词：重新收音')
        this.utterance = []
        this.endpointer.reset()
        this.triggerWake(keyword)
        return
      }
      this.utterance.push(chunk)
      const result = this.endpointer.push(chunk)
      if (result.done) void this.finishUtterance(result.reason)
      return
    }

    if (this.state === 'confirming') {
      this.utterance.push(chunk)
      const result = this.endpointer.push(chunk)
      if (result.done) void this.finishUtterance(result.reason)
      return
    }

    if (this.state === 'speaking' || this.state === 'thinking') {
      // 播报中 / 思考中都能一句话打断：用更灵敏的那个引擎，命中就立刻停嘴去听
      const keyword = this.bargeWatcher?.feed(chunk) ?? null
      if (keyword) {
        logInfo('voice', 'barge-in: 唤醒词「' + keyword + '」，立刻停下听你说')
        this.bargeIn = 0
        this.triggerWake(keyword)
        return
      }

      if (this.state === 'speaking') {
        // 能量插话（默认关）：要求更响、更久，避免扬声器回声把播报掐断
        if (getSettings().bargeIn && now - this.startedSpeakingAt > 800 && rms(chunk) > 0.2) {
          this.bargeIn += 1
          if (this.bargeIn >= 8) {
            logInfo(
              'voice',
              `barge-in: 用户插话了（level=${rms(chunk).toFixed(3)}，${this.bargeIn} 片），停止播报`
            )
            this.bargeIn = 0
            this.interruptForListen()
          }
        } else if (rms(chunk) < 0.05) {
          this.bargeIn = 0
        }
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
    this.cancelContinue()
    // 上一段连续对话可能说了「没事了」提前收尾；再叫醒时按设置恢复
    this.continuous = getSettings().continuous
    this.mutePlayback()
    // 刚从待机跳出来，把待机引擎的旧音频倒掉；播报引擎则等回到待机前不再喂
    this.watcher?.reset()
    this.beginListening()
    this.send(IPC.wake, { text: keyword })
    showPanel()
  }

  private beginListening(): void {
    this.endpointer.reset()
    this.utterance = [...this.preroll]
    this.preroll = []
    this.prerollMs = 0
    this.bargeWatcher?.reset()
    this.setState('listening')
  }

  private interruptForListen(): void {
    this.mutePlayback()
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
      // 连续对话里「嗯」了一声就没了：不出戏，接着听
      if (this.rearmContinuous()) return
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
      if (this.rearmContinuous()) return
      this.toIdle()
      return
    }

    // 打断时那句话里通常带着唤醒词（「大肥鱼，帮我关掉音乐」），去掉再送 DSH
    const said = stripWakeWord(text)
    if (!said) {
      logInfo('voice', '只听清了唤醒词，接着等你说话')
      if (this.continuous) {
        this.beginListening()
      } else {
        this.toIdle()
      }
      return
    }

    // 连续对话里的收尾话术：不进 DSH，直接结束这一段对话
    if (this.continuous && this.isStopTalk(said)) {
      this.sayFarewell()
      return
    }

    await this.deliver(said)
  }

  /** 把一句话交给 DSH（打字和说话都走这里） */
  async deliver(text: string): Promise<void> {
    const clean = text.trim()
    if (!clean) return
    this.cancelContinue()
    this.spokenChars = 0
    this.chunkCount = 0
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
        this.scheduleContinue()
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
        this.runningTurn = frame.running === true
        if (!frame.running && this.state === 'thinking') this.scheduleIdle()
        if (!frame.running && frame.phase === 'idle') this.scheduleContinue()
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
      this.cancelContinue()
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
    this.playbackIdle = false
    this.setState('speaking')
    this.tts.say(clean)
    this.scheduleDrainCheck()
  }

  /**
   * 「说完了」由主进程自己判断：每下发一片音频就把播完时刻往后推这片时长，
   * 到点了就算播完（球窗的回报优先，但它那边的 setTimeout 在后台会被节流，不能只靠它）。
   */
  private scheduleDrainCheck(): void {
    if (this.drainWatchdog) clearTimeout(this.drainWatchdog)
    const wait = Math.max(80, this.audioEndsAt + 260 - Date.now())
    this.drainWatchdog = setTimeout(() => this.checkDrain(), Math.min(wait, 3000))
  }

  private checkDrain(): void {
    this.drainWatchdog = null
    if (this.playbackIdle) return

    // 这一轮压根没有音频（合成失败 / 空文本）：没什么可等的
    if (this.chunkCount === 0) {
      const waited = Date.now() - this.startedSpeakingAt
      if (waited < 2500) {
        this.drainWatchdog = setTimeout(() => this.checkDrain(), 600)
        return
      }
      logError('voice', '这一轮没有音频下发，按已播完处理')
      this.onPlaybackIdle()
      return
    }

    const remain = this.audioEndsAt + 260 - Date.now()
    if (remain > 0) {
      this.drainWatchdog = setTimeout(() => this.checkDrain(), Math.min(Math.max(80, remain), 3000))
      return
    }
    this.onPlaybackIdle()
  }

  /** 球窗播空了（IPC.speechDrained）：这才是「真的说完了」 */
  onPlaybackIdle(): void {
    if (this.drainWatchdog) {
      clearTimeout(this.drainWatchdog)
      this.drainWatchdog = null
    }
    if (this.playbackIdle) return
    this.playbackIdle = true
    logInfo('voice', 'playback drained')
    if (this.state === 'speaking') this.setState(this.link === 'offline' ? 'offline' : 'idle')
    this.scheduleContinue()
  }

  /** 直接念一句（本地提示音性质的话，不进会话） */
  speakNow(text: string): void {
    this.spokenChars += text.length
    this.startedSpeakingAt = Date.now()
    this.playbackIdle = false
    this.setState('speaking')
    this.tts.say(text)
    // 这句话也要能被判成「播完了」，否则状态会卡在 speaking
    this.scheduleDrainCheck()
    this.scheduleIdle(2500)
  }

  /* ------------------------------------------------------- 连续对话的节拍 */

  /**
   * 一轮结束后决定要不要自动接着听。
   * 不喊唤醒词，直接进 listening；但必须等这一轮的话真的念完，
   * 否则自己的声音会被麦克风收进去（回声消除挡不住「刚开始播报」那一下）。
   */
  private scheduleContinue(): void {
    if (!this.continuous) return
    if (this.link === 'offline') return
    if (this.capture) return
    if (this.micEnabled === false) return
    this.cancelContinue()
    this.continueAttempt(Date.now() + 25_000)
  }

  private continueAttempt(deadline: number): void {
    if (!this.continuous || this.link === 'offline' || !this.micEnabled) return
    if (this.capture) return
    if (this.state === 'listening' || this.state === 'confirming') return
    // DSH 还在跑（可能在调工具），等下一次 state 帧再叫
    if (this.runningTurn) return

    const now = Date.now()
    // 关键：等球窗真的播空（以前按字数估，估早了就自动开麦，球窗一进 listening 就把还在播的音频掐了）
    if (this.state === 'speaking' || !this.playbackIdle) {
      if (now > deadline) return
      this.continueTimer = setTimeout(() => this.continueAttempt(deadline), 300)
      return
    }
    if (now > deadline) return

    this.continueTimer = setTimeout(() => {
      this.continueTimer = null
      if (!this.continuous || this.state === 'listening' || this.runningTurn) return
      logInfo('voice', 'continuous: 接着听')
      this.beginListening()
      this.continuousArmedUntil = Date.now() + CONTINUOUS_IDLE_MS
      if (this.listenDeadline) clearTimeout(this.listenDeadline)
      this.listenDeadline = setTimeout(() => {
        this.listenDeadline = null
        if (this.state === 'listening') {
          logInfo('voice', 'continuous: 15 秒没人说话，退回去等唤醒词')
          this.toIdle()
        }
      }, CONTINUOUS_IDLE_MS)
    }, 260)
  }

  /**
   * 连续对话里没听清（太短 / 识别为空）：不出戏，接着听。
   * 只在这一轮 15 秒的窗口内有效，避免一直占着麦克风。
   */
  private rearmContinuous(): boolean {
    if (!this.continuous) return false
    if (this.link === 'offline' || !this.micEnabled) return false
    if (this.capture) return false
    if (Date.now() > this.continuousArmedUntil) return false
    logInfo('voice', 'continuous: 没听清，继续听')
    this.beginListening()
    return true
  }

  private cancelContinue(): void {
    if (this.continueTimer) {
      clearTimeout(this.continueTimer)
      this.continueTimer = null
    }
    if (this.listenDeadline) {
      clearTimeout(this.listenDeadline)
      this.listenDeadline = null
    }
  }

  /** 连续对话里的收尾话术 */
  private isStopTalk(text: string): boolean {
    const clean = text.replace(/\s+/g, '')
    if (!clean) return false
    if (!STOP_TALK.test(clean)) return false
    // 「没事了」「先这样吧」这种短句才收尾；长句里带这几个字多半是在说别的事
    return clean.length <= 16
  }

  private sayFarewell(): void {
    logInfo('voice', 'continuous: 收尾')
    this.continuous = false
    this.cancelContinue()
    this.speak('好，有事再叫我。')
    setTimeout(() => this.toIdle(), 2600)
  }

  private scheduleIdle(delay = 1200): void {
    setTimeout(() => {
      if (this.state !== 'speaking' && this.state !== 'thinking') return
      // 还在播就等 onPlaybackIdle 收尾；别让状态先变成 idle
      if (!this.playbackIdle) return
      this.toIdle()
    }, delay)
  }

  /** 真正要静音（唤醒 / 插话 / 面板停止）：连已经在播的缓冲一起掐掉 */
  private mutePlayback(): void {
    this.tts.stop()
    this.playbackIdle = false
    this.send(IPC.speechStop, null)
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
    this.mutePlayback()
    this.toIdle()
  }

  /** DSH 那一轮被打断 */
  interruptTurn(): void {
    this.cancelContinue()
    void getBridge()
      .stopTurn()
      .catch((error) => logError('stopTurn', error))
    this.mutePlayback()
    this.scheduleIdle(400)
  }

  /** 唤醒提示（面板按钮用） */
  wakeByHand(): void {
    this.triggerWake('按钮')
  }

  stopPlaybackOnly(): void {
    this.mutePlayback()
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
