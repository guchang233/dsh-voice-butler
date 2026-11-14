import { getOverlay } from './windows'

/**
 * 屏幕顶部的状态特效。
 * voice = 听到你、在想、在说（冷色）
 * action = 正在动手操作电脑（暖色）
 */
export type OverlayMode = 'off' | 'voice' | 'action'

let butlerState = 'idle'
let toolDepth = 0
let hideTimer: NodeJS.Timeout | null = null

export function overlaySetState(state: string): void {
  butlerState = state
  push()
}

export function overlayToolStart(): void {
  toolDepth += 1
  push()
}

export function overlayToolEnd(): void {
  toolDepth = Math.max(0, toolDepth - 1)
  push()
}

export function resetOverlay(): void {
  toolDepth = 0
  butlerState = 'idle'
  push()
}

function push(): void {
  const win = getOverlay()
  if (!win || win.isDestroyed()) return

  let mode: OverlayMode = 'off'
  if (toolDepth > 0) mode = 'action'
  else if (['listening', 'thinking', 'speaking', 'confirming'].includes(butlerState)) mode = 'voice'

  win.webContents.send('overlay:state', { mode, phase: butlerState, tools: toolDepth })

  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
  if (mode === 'off') {
    // 留 500ms 让渲染层把淡出播完再藏窗口
    hideTimer = setTimeout(() => {
      try {
        if (win && !win.isDestroyed() && toolDepth === 0 && !['listening', 'thinking', 'speaking', 'confirming'].includes(butlerState)) {
          win.hide()
        }
      } catch {
        /* ignore */
      }
    }, 500)
    return
  }
  try {
    if (!win.isVisible()) win.showInactive()
  } catch {
    /* ignore */
  }
}
