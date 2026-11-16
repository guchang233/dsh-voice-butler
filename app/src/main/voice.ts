import { createEndpointer, rms, SAMPLE_RATE } from './audio/vad'
import { createKeywordWatcher, WAKE_WORD_TEXT, type KeywordWatcher } from './audio/kws'
import { getBridge } from './bridge'
import { logError, logInfo } from './log'
import { overlaySetState, overlayToolEnd, overlayToolStart } from './overlay'
import { transcribe } from './speech/asr'
import { OnlineAsr } from './speech/online-asr'
import { SentenceChunker, TtsQueue, TTS_SAMPLE_RATE } from './speech/tts'
import { getApiKey, getAsrKey, getSettings } from './store'
import { getBall, getPanel, showPanel } from './windows'
import { approvalPrompt, decideVoiceApproval, isDangerousApproval, tooCloseToPrompt } from '../shared/confirm'
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

/** 叫醒后先丢掉这么长的音频：唤醒词检测有几帧延迟，不丢就会把「大肥鱼」录进转写 */
const WAKE_SKIP_MS = 280
const MIN_UTTERANCE_MS = 350
/** 整段里只要有超过这个能量的分片，才算「听到人了」；全静音就不发识别（省额度） */
const SPEECH_RMS = 0.02
const MAX_UTTERANCE_MS = 15_000
/** 连续对话里，静默这么久没人说话就退回去等唤醒词 */
const CONTINUOUS_IDLE_MS = 15_000

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
  /** 伪流式识别：边说边出字幕，收尾再整段重识别 */
  private readonly asr: OnlineAsr
  /** 播报 / 思考时用的引擎：门限更低，方便一句话把管家打断 */
  private bargeWatcher: KeywordWatcher | null = null
  private endpointer = createEndpointer({ maxMs: MAX_UTTERANCE_MS })
  private state: VoiceState = 'idle'
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
  /** 这段时间内的音频直接丢（叫醒后跳过唤醒词尾巴） */
  private skipUntil = 0
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
  /** 正在问的那句确认词，用来丢掉「把自己的问句听成回答」 */
  private askedPrompt = ''
  private playbackWaiters: Array<() => void> = []

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
      (error) => logError('tts', error),
    )
    this.asr = new OnlineAsr(async (wav) => {
      const settings = getSettings()
      const provider = settings.asrProvider
      const key = provider === 'deepseek' ? getApiKey() : getAsrKey()
      if (!key) {
        throw new Error(provider === 'deepseek' ? '还没有配置语音钥匙' : '还没有配置语音识别的 Key')
      }
      return transcribe(provider, key, wav, settings.baseUrl)
    })
    this.asr.onUpdate((shown) => {
      if (this.state !== 'listening' && this.state !== 'confirming') return
      this.send(IPC.asrPartial, shown)
    })
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
    this.asr.reset()
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
          }`,
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
      // 刚被叫醒：这几百毫秒里压着唤醒词的尾巴，直接丢掉，别录进转写
      if (this.skipUntil && now < this.skipUntil) return
      // 已经在听的时候也认唤醒词：喊一声就当作「重新叫我」——
      // 否则连续对话一直在听，喊唤醒词既没响动也不弹面板，看起来就像坏了。
      const keyword = this.watcher?.feed(chunk) ?? null
      if (keyword) {
        logInfo('voice', 'listening 中又喊了唤醒词：重新收音')
        this.utterance = []
        this.endpointer.reset()
        this.asr.reset()
        this.triggerWake(keyword)
        return
      }
      this.utterance.push(chunk)
      this.asr.push(chunk)
      const result = this.endpointer.push(chunk)
      if (this.endpointer.speechStarted) {
        this.asr.markHeard()
        this.asr.kick()
      }
      if (result.done) void this.finishUtterance(result.reason)
      return
    }

    if (this.state === 'confirming') {
      this.utterance.push(chunk)
      this.asr.push(chunk)
      const result = this.endpointer.push(chunk)
      if (this.endpointer.speechStarted) {
        this.asr.markHeard()
        this.asr.kick()
      }
      if (result.done) void this.finishUtterance(result.reason)
      return
    }

    if (this.state === 'speaking' || this.state === 'thinking') {
      // 播报中 / 思考中：**只有喊唤醒词**才打断（用更灵敏的那个引擎）。
      // 不再用「声音变大就掐播报」——回声、电视、别人说话都会误伤，主人要的是他亲口叫。
      if (!getSettings().bargeIn) return
      const keyword = this.bargeWatcher?.feed(chunk) ?? null
      if (keyword) {
        logInfo('voice', 'barge-in: 唤醒词「' + keyword + '」，立刻停下听你说')
        this.triggerWake(keyword)
      }
      return
    }

    if (this.state !== 'idle' && this.state !== 'offline') return

    if (!this.watcher) return
    const keyword = this.watcher.feed(chunk)
    if (keyword) this.triggerWake(keyword)
  }


  private triggerWake(keyword: string): void {
    logInfo('voice', 'wake: ' + keyword)
    this.cancelContinue()
    // 上一段连续对话可能说了「没事了」提前收尾；再叫醒时按设置恢复
    this.continuous = getSettings().continuous
    this.mutePlayback()
    // 刚从待机跳出来，把待机引擎的旧音频倒掉；播报引擎则等回到待机前不再喂
    this.watcher?.reset()
    // 唤醒词自己不该被录进去：从「说完大肥鱼」之后才开始收
    this.beginListening(WAKE_SKIP_MS)
    this.send(IPC.wake, { text: keyword })
    showPanel()
  }

  /**
   * 开始收音。
   *
   * `skipMs`：先丢掉开头这么多毫秒。叫醒时用它是为了不让「大肥鱼」进转写——
   * 唤醒词检测有几帧延迟，检测到的那一刻音频里还压着关键词的尾巴。
   * **不再把 preroll 预置进 utterance**：那 700ms 里正好就是唤醒词。
   */
  private beginListening(skipMs = 0): void {
    this.endpointer.reset()
    this.asr.reset()
    this.utterance = []
    this.skipUntil = skipMs > 0 ? Date.now() + skipMs : 0
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
    const totalMs = chunks.reduce((n, c) => n + c.length, 0) / SAMPLE_RATE * 1000
    // 端点检测有没有真的听到人声（reset 之前赶紧读）
    const heardSpeech =
      this.endpointer.speechStarted || chunks.some((chunk) => rms(chunk) > SPEECH_RMS)
    this.utterance = []
    this.endpointer.reset()

    const capture = this.capture

    // 太短、或者整段都是静音：不发识别。连续对话里「15 秒没人说话」也走这条路，
    // 以前会把一整段沉默丢给 ASR（有请求、没结果），白烧额度。
    if (totalMs < MIN_UTTERANCE_MS || !heardSpeech) {
      if (!heardSpeech && totalMs >= MIN_UTTERANCE_MS) {
        logInfo('voice', `这一轮没听到人声（${Math.round(totalMs)}ms），跳过识别`)
      }
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
    const needsKey = settings.asrProvider === 'deepseek' ? getApiKey() : getAsrKey()
    if (!needsKey) {
      this.toIdle()
      this.send(IPC.voiceState, { state: 'error' })
      this.speakNow(
        settings.asrProvider === 'deepseek'
          ? '还没配语音钥匙，打开面板填一下。'
          : '还没配语音识别的 Key，打开面板填一下。'
      )
      return
    }

    let text = ''
    try {
      logInfo('voice', `utterance ${Math.round(totalMs)}ms reason=${reason ?? '-'} -> asr`)
      text = await this.asr.finish()
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
        const activity = frame.activity === 'mouse' ? 'mouse' : 'tool'
        if (frame.phase === 'start') overlayToolStart(activity)
        else overlayToolEnd(activity)
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

  /**
   * DSH 弹确认时先把问句念完，再开麦。
   * 问句不含肯定词；和问句太像的识别结果丢掉。
   * 危险操作只能在面板上点允许，语音顶多拒绝。
   */
  private async askApproval(frame: { id: string; tool: string; reason: string }): Promise<void> {
    const summary = frame.reason?.trim() || frame.tool
    const prompt = approvalPrompt(summary)
    this.askedPrompt = prompt
    this.speak(prompt)
    await this.waitUntilQuiet()
    if (this.approval?.id !== frame.id) return
    const answer = await this.listenOnce(9000)
    if (this.approval?.id !== frame.id) return
    if (!answer) return
    if (tooCloseToPrompt(answer, prompt)) {
      logInfo('voice', '丢弃和问句太像的识别：' + answer)
      return
    }
    const dangerous = isDangerousApproval(frame.tool, frame.reason)
    const decision = decideVoiceApproval(answer, dangerous)
    logInfo('voice', `确认「${answer}」→ ${decision}（dangerous=${dangerous}）`)
    if (decision === 'deny') {
      this.approval = null
      void getBridge()
        .approve(frame.id, false)
        .catch((error) => logError('approve', error))
      return
    }
    if (decision === 'allow') {
      this.approval = null
      void getBridge()
        .approve(frame.id, true)
        .catch((error) => logError('approve', error))
      return
    }
    if (decision === 'needs-click') {
      this.speakNow('这个要在面板上点允许。')
    }
  }

  /** 等这一轮真的念完再开麦，避免把问句自己收进去 */
  private waitUntilQuiet(timeoutMs = 20_000): Promise<void> {
    if (this.playbackIdle) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.playbackWaiters = this.playbackWaiters.filter((fn) => fn !== done)
        resolve()
      }, timeoutMs)
      const done = (): void => {
        clearTimeout(timer)
        resolve()
      }
      this.playbackWaiters.push(done)
    })
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
    const waiters = this.playbackWaiters
    this.playbackWaiters = []
    for (const fn of waiters) fn()
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

  /** 按住说话：按下就听，松开就把这一句送去识别。不念唤醒提示音。 */
  pushToTalk(down: boolean): void {
    if (!this.micEnabled) return
    if (down) {
      this.cancelContinue()
      if (this.state === 'speaking' || this.state === 'thinking') this.mutePlayback()
      this.beginListening()
      showPanel()
      logInfo('voice', 'ptt down')
      return
    }
    if (this.state === 'listening' && !this.capture) {
      logInfo('voice', 'ptt up')
      void this.finishUtterance('ptt')
    }
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
