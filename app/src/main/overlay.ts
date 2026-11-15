import type { ToolActivity } from '../shared/ipc'
import { logInfo } from './log'
import { getOverlay } from './windows'

/**
 * 屏幕上的状态特效。
 *
 *   绿 = 唤醒后在听你说（wake）
 *   蓝 = 在想 / 在说（think）
 *   橙 = 正在操作这台电脑（act）
 *   橙 + 四边全亮 = 已经在动鼠标、敲键盘操作界面了（mouse）
 *
 * 颜色由模式决定，强度由渲染层决定；这一层只管「现在该是哪个模式」。
 */
export type OverlayMode = 'off' | 'wake' | 'think' | 'act' | 'mouse'

/** 鼠标特效结束后多留一会儿，否则快速点一下就闪没了 */
const MOUSE_LINGER_MS = 1600
/** 普通工具同理，稍微短一点 */
const ACT_LINGER_MS = 700

let voicePhase = 'idle'
let toolCount = 0
let mouseCount = 0
let mouseHoldUntil = 0
let actHoldUntil = 0
let hideTimer: NodeJS.Timeout | null = null
/** 当前模式的进入时刻（渲染层用它播开场动画） */
let modeSince = Date.now()
let currentMode: OverlayMode = 'off'
/** 调试：锁定成某个模式，不再被真实状态覆盖 */
let demoMode: OverlayMode | null = null

export function overlaySetState(state: string): void {
  voicePhase = state
  push()
}

export function overlayToolStart(activity: ToolActivity = 'tool'): void {
  if (activity === 'mouse') {
    mouseCount += 1
    mouseHoldUntil = Date.now() + MOUSE_LINGER_MS
  } else {
    toolCount += 1
    actHoldUntil = Date.now() + ACT_LINGER_MS
  }
  push()
}

export function overlayToolEnd(activity: ToolActivity = 'tool'): void {
  const now = Date.now()
  if (activity === 'mouse') {
    mouseCount = Math.max(0, mouseCount - 1)
    mouseHoldUntil = now + MOUSE_LINGER_MS
  } else {
    toolCount = Math.max(0, toolCount - 1)
    actHoldUntil = now + ACT_LINGER_MS
  }
  push()
}

export function resetOverlay(): void {
  toolCount = 0
  mouseCount = 0
  mouseHoldUntil = 0
  actHoldUntil = 0
  voicePhase = 'idle'
  push()
}

function computeMode(): OverlayMode {
  const now = Date.now()
  if (mouseCount > 0 || now < mouseHoldUntil) return 'mouse'
  if (toolCount > 0 || now < actHoldUntil) return 'act'
  if (voicePhase === 'thinking' || voicePhase === 'speaking' || voicePhase === 'confirming') {
    return 'think'
  }
  if (voicePhase === 'listening') return 'wake'
  return 'off'
}

function push(): void {
  const win = getOverlay()
  if (!win || win.isDestroyed()) return

  const mode: OverlayMode = demoMode ?? computeMode()
  if (mode !== currentMode) {
    currentMode = mode
    modeSince = Date.now()
    logInfo('overlay', `模式 → ${mode}（工具 ${toolCount} / 鼠标 ${mouseCount} / 语音 ${voicePhase}）`)
  }

  win.webContents.send('overlay:state', {
    mode,
    phase: voicePhase,
    tools: toolCount,
    mouse: mouseCount,
    since: modeSince
  })

  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }

  if (mode === 'off') {
    // 留 900ms 给渲染层把淡出播完再藏窗口（改版后出场动画更长）
    hideTimer = setTimeout(() => {
      try {
        if (win && !win.isDestroyed() && (demoMode ?? computeMode()) === 'off') win.hide()
      } catch {
        /* ignore */
      }
    }, 900)
    return
  }

  try {
    if (!win.isVisible()) win.showInactive()
  } catch {
    /* ignore */
  }

  // 让「残留」到点自然消失：不然 linger 结束后没人再 push 一次
  const now = Date.now()
  const expiresAt = Math.max(mouseCount > 0 || toolCount > 0 ? 0 : mouseHoldUntil, actHoldUntil)
  const wait = expiresAt - now
  if (wait > 0 && wait < 10_000 && !demoMode) {
    hideTimer = setTimeout(() => {
      hideTimer = null
      push()
    }, wait + 30)
  }
}

/* ---------------------------------------------------------------- 调试 */

/** 调试：`BUTLER_OVERLAY_MODE=wake|think|act|mouse` 直接把特效钉在这个模式 */
export function lockOverlayMode(mode: OverlayMode | null): void {
  demoMode = mode
  push()
}
