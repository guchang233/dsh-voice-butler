import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LinkState, VoiceFrame } from '../shared/ipc'
import { logError, logInfo } from './log'
import { getSettings } from './store'

/**
 * 与 DSH 的通道。
 *
 * 这个进程只做语音：把听见的一句话 POST 给 butler-bridge，然后长轮询它推回来的帧
 * （助手逐字增量、工具轨迹、确认、状态），交给上面去念、去显示。
 * 不在这里思考，也不在这里调工具。
 */

const STATE_DIR = path.join(os.homedir(), '.dsh', 'butler-bridge')
const ENDPOINT_FILE = path.join(STATE_DIR, 'endpoint.json')
const SHELL_FILE = path.join(STATE_DIR, 'shell.json')
const FALLBACK_ORIGIN = 'http://127.0.0.1:63563'

const POLL_WAIT_MS = 20_000
const POLL_TIMEOUT_MS = 32_000
const RETRY_MS = 1500

type Handler = {
  frame: (frame: VoiceFrame) => void
  history: (frames: VoiceFrame[]) => void
  reset: () => void
  link: (link: LinkState, origin: string) => void
}

function readOriginFrom(file: string): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { origin?: string }
    const origin = typeof parsed.origin === 'string' ? parsed.origin.trim() : ''
    return origin.replace(/\/+$/, '')
  } catch {
    return ''
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export class DshBridge {
  private origin = ''
  private cursor = -1
  private running = false
  private link: LinkState = 'connecting'
  private sessionId: string | null = null
  private preset: string | null = null
  private phase = 'idle'
  private runningTurn = false
  private lastError: string | null = null
  private handler: Handler | null = null
  private loopPromise: Promise<void> | null = null

  /** 挑一个能用的 DSH 地址：手填的 > 桥写的 endpoint > 守护写的 shell > 默认端口 */
  resolveOrigin(): string {
    const manual = getSettings().dshOrigin.trim().replace(/\/+$/, '')
    if (manual) return manual
    const live = readOriginFrom(ENDPOINT_FILE)
    if (live) return live
    const shell = readOriginFrom(SHELL_FILE)
    if (shell) return shell
    const env = (process.env['BUTLER_DSH_ORIGIN'] ?? '').trim().replace(/\/+$/, '')
    if (env) return env
    return FALLBACK_ORIGIN
  }

  start(handler: Handler): void {
    this.handler = handler
    if (this.running) return
    this.running = true
    this.origin = this.resolveOrigin()
    this.setLink('connecting')
    this.loopPromise = this.loop()
    logInfo('bridge', 'start, origin = ' + this.origin)
  }

  stop(): void {
    this.running = false
    this.cursor = -1
  }

  status(): {
    link: LinkState
    sessionId: string | null
    preset: string | null
    running: boolean
    phase: string
    origin: string
    lastError: string | null
  } {
    return {
      link: this.link,
      sessionId: this.sessionId,
      preset: this.preset,
      running: this.runningTurn,
      phase: this.phase,
      origin: this.origin || this.resolveOrigin(),
      lastError: this.lastError
    }
  }

  /* ---------------------------------------------------------- 对 DSH 的动作 */

  async say(text: string): Promise<void> {
    const body = JSON.stringify({ text })
    await this.post('/voice/say', body, 35_000)
  }

  async stopTurn(): Promise<void> {
    await this.post('/voice/stop', '{}', 10_000)
  }

  async approve(id: string, allow: boolean): Promise<void> {
    await this.post('/voice/approve', JSON.stringify({ id, allow }), 10_000)
  }

  async newSession(): Promise<void> {
    await this.post('/voice/new', '{}', 20_000)
    this.cursor = -1
  }

  /* ------------------------------------------------------------ 人格提示词 */

  async getPersona(): Promise<{ text: string; isDefault: boolean }> {
    const origin = this.origin || this.resolveOrigin()
    const res = await fetch(`${origin}/voice/persona`, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error(`读人格失败（HTTP ${res.status}）`)
    const body = (await res.json()) as { text?: string; isDefault?: boolean }
    return { text: String(body.text ?? ''), isDefault: body.isDefault !== false }
  }

  async savePersona(text: string): Promise<{ text: string; isDefault: boolean }> {
    const origin = this.origin || this.resolveOrigin()
    const res = await fetch(`${origin}/voice/persona`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(20_000)
    })
    const body = (await res.json()) as { ok?: boolean; text?: string; isDefault?: boolean; error?: string }
    if (!res.ok || body.ok === false) throw new Error(body.error || `保存人格失败（HTTP ${res.status}）`)
    return { text: String(body.text ?? ''), isDefault: body.isDefault === true }
  }

  async resetPersona(): Promise<{ text: string; isDefault: boolean }> {
    const origin = this.origin || this.resolveOrigin()
    const res = await fetch(`${origin}/voice/persona-reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: '{}',
      signal: AbortSignal.timeout(15_000)
    })
    const body = (await res.json()) as { ok?: boolean; text?: string; error?: string }
    if (!res.ok || body.ok === false) throw new Error(body.error || `恢复默认失败（HTTP ${res.status}）`)
    return { text: String(body.text ?? ''), isDefault: true }
  }

  /* ------------------------------------------------------------------ 内部 */

  private setLink(next: LinkState): void {
    if (this.link === next) return
    this.link = next
    this.handler?.link(next, this.origin)
    logInfo('bridge', 'link = ' + next)
  }

  private async post(route: string, body: string, timeoutMs: number): Promise<void> {
    const origin = this.origin || this.resolveOrigin()
    const res = await fetch(`${origin}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body,
      signal: AbortSignal.timeout(timeoutMs)
    })
    const text = await res.text()
    let parsed: { ok?: boolean; error?: string } = {}
    try {
      parsed = text ? (JSON.parse(text) as { ok?: boolean; error?: string }) : {}
    } catch {
      parsed = {}
    }
    if (!res.ok || parsed.ok === false) {
      throw new Error(parsed.error || `DSH 返回 ${res.status}`)
    }
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        if (!this.origin) this.origin = this.resolveOrigin()
        const url = `${this.origin}/voice/frames?cursor=${this.cursor}&wait=${POLL_WAIT_MS}`
        const res = await fetch(url, { signal: AbortSignal.timeout(POLL_TIMEOUT_MS) })
        if (!res.ok) throw new Error('HTTP ' + res.status)
        const body = (await res.json()) as {
          ok?: boolean
          reset?: boolean
          cursor?: number
          frames?: VoiceFrame[]
          history?: VoiceFrame[]
          sessionId?: string | null
          preset?: string | null
          running?: boolean
          phase?: string
          error?: string | null
        }
        if (body.ok === false) throw new Error(body.error || 'bridge error')

        this.origin = this.origin || this.resolveOrigin()
        this.setLink('online')
        this.lastError = body.error ?? null

        if (typeof body.sessionId === 'string') this.sessionId = body.sessionId
        if (typeof body.preset === 'string') this.preset = body.preset
        if (typeof body.running === 'boolean') this.runningTurn = body.running
        if (typeof body.phase === 'string') this.phase = body.phase

        if (body.reset) {
          this.handler?.reset()
          const history = Array.isArray(body.history) ? body.history : []
          if (history.length) this.handler?.history(history)
        }
        for (const frame of body.frames ?? []) this.emit(frame)

        if (typeof body.cursor === 'number' && body.cursor >= 0) this.cursor = body.cursor
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (this.link !== 'offline') logError('bridge poll', message)
        this.lastError = /abort|timeout/i.test(message) ? 'DSH 没有响应' : message
        this.setLink('offline')
        // DSH 可能换了端口：每轮都重新找一遍地址
        this.origin = this.resolveOrigin()
        await sleep(RETRY_MS)
      }
    }
  }

  private emit(frame: VoiceFrame): void {
    if (!frame || typeof frame !== 'object') return
    if (frame.t === 'hello') {
      if (typeof frame.sessionId === 'string') this.sessionId = frame.sessionId
      if (typeof frame.preset === 'string') this.preset = frame.preset
    }
    if (frame.t === 'state') {
      this.runningTurn = frame.running === true
      this.phase = frame.phase
    }
    this.handler?.frame(frame)
  }
}

let instance: DshBridge | null = null

export function getBridge(): DshBridge {
  if (!instance) instance = new DshBridge()
  return instance
}
