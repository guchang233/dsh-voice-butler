import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { IPC } from '../shared/ipc'
import { logError, logInfo } from './log'
import { saveBallPosition } from './store'

export const BALL_W = 112
export const BALL_H = 112
export const PANEL_W = 420
export const PANEL_H = 620

const SNAP_MARGIN = 14

let ball: BrowserWindow | null = null
let panel: BrowserWindow | null = null
let quitting = false

const preloadPath = (): string => join(__dirname, '../preload/index.js')

function loadPage(win: BrowserWindow, page: 'ball' | 'panel' | 'overlay' | 'peek'): void {
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    logError('preload-error', page, preloadPath, error)
  })
  win.webContents.on('console-message', (_event, level, message) => {
    // 只留真正的报错，别把 Electron 每次启动的 CSP 提示写进日志
    if (level >= 3) logError(`console[${page}]`, message)
  })
  const base = process.env['ELECTRON_RENDERER_URL']
  if (base) {
    void win.loadURL(`${base}/${page}/index.html`)
  } else {
    void win.loadFile(join(__dirname, `../renderer/${page}/index.html`))
  }
}

/* ------------------------------------------------------------------ 悬浮球 */

export function createBall(saved: { x: number; y: number } | null): BrowserWindow {
  const display = screen.getPrimaryDisplay()
  const wa = display.workArea
  const x = saved?.x ?? wa.x + wa.width - BALL_W - SNAP_MARGIN
  const y = saved?.y ?? wa.y + Math.round(wa.height * 0.72)

  ball = new BrowserWindow({
    width: BALL_W,
    height: BALL_H,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    focusable: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: preloadPath(),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })

  ball.setAlwaysOnTop(true, 'screen-saver')
  ball.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // 不做鼠标穿透：Windows 的 SetIgnoreMouseEvents 在「刚改过状态、鼠标还没动」时会丢点击，
  // 表现为「点一下之后就一直穿过去」。窗口缩到正好包住鲸鱼，四角那点空白当作代价。
  ball.setIgnoreMouseEvents(false)
  startHoverWatch()

  ball.once('ready-to-show', () => ball?.showInactive())
  loadPage(ball, 'ball')
  return ball
}

export function getBall(): BrowserWindow | null {
  return ball
}

/**
 * 悬停动画由渲染层的 pointerenter/pointerleave 直接驱动（窗口一直可交互，事件是可靠的）。
 * 这里只保留 tick 广播，供球窗做电平/状态动画用。
 */
let hoverTimer: NodeJS.Timeout | null = null

function startHoverWatch(): void {
  if (hoverTimer) return
  hoverTimer = setInterval(() => {
    // 状态动画在渲染层自己跑；主进程不再干预穿透
  }, 500)
}

export function broadcastSkin(skin: string): void {
  ball?.webContents.send('skin:changed', skin)
  panel?.webContents.send('skin:changed', skin)
}

export function stopHoverWatch(): void {
  if (hoverTimer) {
    clearInterval(hoverTimer)
    hoverTimer = null
  }
}



/* --------------------------------------------------------------- 拖拽与吸附 */

let dragTimer: NodeJS.Timeout | null = null
let dragOffset = { x: 0, y: 0 }
/**
 * 拖动期间面板 / 卡片相对球的位置。抓一次固定偏移，之后只做平移——
 * 以前每 4 拍重新算一次吸附点，既掉帧又会在球越过屏幕中线时突然翻面。
 */
let dragPanelOffset: { x: number; y: number } | null = null
let dragPeekOffset: { x: number; y: number } | null = null

/** 拖之前先记下「面板 / 卡片现在贴在球的哪一侧」 */
function captureFollowers(): void {
  const ballBounds = ball?.getBounds()
  dragPanelOffset = null
  dragPeekOffset = null
  if (!ballBounds) return
  if (panel && !panel.isDestroyed() && panel.isVisible()) {
    const b = panel.getBounds()
    dragPanelOffset = { x: b.x - ballBounds.x, y: b.y - ballBounds.y }
  }
  if (peek && !peek.isDestroyed() && peek.isVisible()) {
    const b = peek.getBounds()
    dragPeekOffset = { x: b.x - ballBounds.x, y: b.y - ballBounds.y }
  }
}

/** 让面板和卡片跟着球一起平移（夹在球所在显示器的工作区里，别跟着飞出屏幕） */
function moveFollowers(ballX: number, ballY: number): void {
  const ballBounds = ball?.getBounds()
  const wa = screen.getDisplayNearestPoint({
    x: ballX + Math.round((ballBounds?.width ?? 112) / 2),
    y: ballY + Math.round((ballBounds?.height ?? 112) / 2)
  }).workArea

  if (dragPanelOffset && panel && !panel.isDestroyed() && panel.isVisible()) {
    panel.setPosition(
      Math.round(clamp(ballX + dragPanelOffset.x, wa.x + 4, wa.x + wa.width - PANEL_W - 4)),
      Math.round(clamp(ballY + dragPanelOffset.y, wa.y + 4, wa.y + wa.height - PANEL_H - 4)),
      false
    )
  }
  if (dragPeekOffset && peek && !peek.isDestroyed() && peek.isVisible()) {
    peek.setPosition(
      Math.round(clamp(ballX + dragPeekOffset.x, wa.x + 4, wa.x + wa.width - PEEK_W - 4)),
      Math.round(clamp(ballY + dragPeekOffset.y, wa.y + 4, wa.y + wa.height - PEEK_H - 4)),
      false
    )
  }
}

export function startDrag(): void {
  if (!ball) return
  const bounds = ball.getBounds()
  const cursor = screen.getCursorScreenPoint()
  dragOffset = { x: cursor.x - bounds.x, y: cursor.y - bounds.y }
  captureFollowers()
  stopDragTimer()

  let lastX = bounds.x
  let lastY = bounds.y
  dragTimer = setInterval(() => {
    if (!ball || ball.isDestroyed()) return
    const point = screen.getCursorScreenPoint()
    const x = Math.round(point.x - dragOffset.x)
    const y = Math.round(point.y - dragOffset.y)
    // 位置没变就别白跑一趟（setPosition 在 Windows 上并不便宜）
    if (x === lastX && y === lastY) return
    lastX = x
    lastY = y
    ball.setPosition(x, y, false)
    moveFollowers(x, y)
  }, 8)
}

function stopDragTimer(): void {
  if (dragTimer) {
    clearInterval(dragTimer)
    dragTimer = null
  }
}

export function endDrag(): void {
  stopDragTimer()
  snapToNearestEdge()
}

function snapToNearestEdge(): void {
  if (!ball) return
  const bounds = ball.getBounds()
  const display = screen.getDisplayNearestPoint({
    x: bounds.x + Math.round(bounds.width / 2),
    y: bounds.y + Math.round(bounds.height / 2)
  })
  const wa = display.workArea

  const candidates = [
    { x: wa.x + SNAP_MARGIN, y: bounds.y, d: Math.abs(bounds.x - (wa.x + SNAP_MARGIN)) },
    {
      x: wa.x + wa.width - bounds.width - SNAP_MARGIN,
      y: bounds.y,
      d: Math.abs(bounds.x - (wa.x + wa.width - bounds.width - SNAP_MARGIN))
    },
    { x: bounds.x, y: wa.y + SNAP_MARGIN, d: Math.abs(bounds.y - (wa.y + SNAP_MARGIN)) },
    {
      x: bounds.x,
      y: wa.y + wa.height - bounds.height - SNAP_MARGIN,
      d: Math.abs(bounds.y - (wa.y + wa.height - bounds.height - SNAP_MARGIN))
    }
  ]

  const target = candidates.reduce((a, b) => (b.d < a.d ? b : a))
  const from = { x: bounds.x, y: bounds.y }
  const to = {
    x: clamp(target.x, wa.x, wa.x + wa.width - bounds.width),
    y: clamp(target.y, wa.y, wa.y + wa.height - bounds.height)
  }

  animatePosition(
    from,
    to,
    180,
    (x, y) => moveFollowers(x, y),
    () => {
      saveBallPosition(to)
      dragPanelOffset = null
      dragPeekOffset = null

      // 落位后只有在「压到球上」时才重新选边；否则保持你拖到的相对位置，别无缘无故跳一下
      const ballRect = ball?.getBounds()
      const panelRect = panel && !panel.isDestroyed() && panel.isVisible() ? panel.getBounds() : null
      if (ballRect && panelRect && overlapsPanel(panelRect, ballRect, 6)) syncPanelToBall()

      const peekRect = peek && !peek.isDestroyed() && peek.isVisible() ? peek.getBounds() : null
      if (ballRect && peekRect && overlapsPanel(peekRect, ballRect, 6)) {
        const { x, y } = peekBounds()
        peek?.setPosition(Math.round(x), Math.round(y), false)
      }
    }
  )
}

/** 球动过之后让面板跟着让位，否则面板底部会压在球上（点「发送」就变成点球了） */
function syncPanelToBall(): void {
  if (!panel || panel.isDestroyed() || !panel.isVisible()) return
  const { x, y } = anchorBounds()
  panel.setBounds({ x, y, width: PANEL_W, height: PANEL_H })
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

function animatePosition(
  from: { x: number; y: number },
  to: { x: number; y: number },
  duration: number,
  onStep?: (x: number, y: number) => void,
  done?: () => void
): void {
  const start = Date.now()
  const timer = setInterval(() => {
    if (!ball || ball.isDestroyed()) {
      clearInterval(timer)
      return
    }
    const t = Math.min(1, (Date.now() - start) / duration)
    const e = 1 - Math.pow(1 - t, 3)
    const x = Math.round(from.x + (to.x - from.x) * e)
    const y = Math.round(from.y + (to.y - from.y) * e)
    ball.setPosition(x, y, false)
    onStep?.(x, y)
    if (t >= 1) {
      clearInterval(timer)
      done?.()
    }
  }, 8)
}

/* -------------------------------------------------------------------- 面板 */

export function createPanel(): BrowserWindow {
  panel = new BrowserWindow({
    width: PANEL_W,
    height: PANEL_H,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: preloadPath(),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })

  panel.setAlwaysOnTop(true, 'floating')
  // 构造参数里的 skipTaskbar 有时被 show() 还原，这里再钉一次
  panel.setSkipTaskbar(true)
  panel.setMenu(null)
  panel.on('close', (event) => {
    // 关闭按钮只是隐藏，托盘负责真正退出
    if (!quitting) {
      event.preventDefault()
      panel?.hide()
    }
  })
  loadPage(panel, 'panel')
  return panel
}

export function markQuitting(): void {
  quitting = true
}

/* ------------------------------------------------------ 右键小卡片（时段/余额） */

export const PEEK_W = 268
export const PEEK_H = 178

let peek: BrowserWindow | null = null
let peekTimer: NodeJS.Timeout | null = null

export function getPeek(): BrowserWindow | null {
  return peek
}

export function createPeek(): BrowserWindow {
  peek = new BrowserWindow({
    width: PEEK_W,
    height: PEEK_H,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: preloadPath(),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  peek.setAlwaysOnTop(true, 'screen-saver')
  peek.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  peek.setMenu(null)
  loadPage(peek, 'peek')
  return peek
}

/** 贴着球放：优先在球上方，放不下就下方，再不行居中偏上，全部夹在工作区内 */
function peekBounds(): { x: number; y: number } {
  const ballBounds = ball?.getBounds()
  const wa = ballBounds
    ? screen.getDisplayNearestPoint({
        x: ballBounds.x + Math.round(ballBounds.width / 2),
        y: ballBounds.y + Math.round(ballBounds.height / 2)
      }).workArea
    : screen.getPrimaryDisplay().workArea
  const gap = 10

  if (!ballBounds) {
    return {
      x: clamp(wa.x + wa.width - PEEK_W - 20, wa.x + 8, wa.x + wa.width - PEEK_W - 8),
      y: wa.y + 80
    }
  }

  const centered = ballBounds.x + Math.round(ballBounds.width / 2) - Math.round(PEEK_W / 2)
  const x = clamp(centered, wa.x + 8, wa.x + wa.width - PEEK_W - 8)
  const above = ballBounds.y - PEEK_H - gap
  const below = ballBounds.y + ballBounds.height + gap

  let y: number
  if (above >= wa.y + 8) y = above
  else if (below + PEEK_H <= wa.y + wa.height - 8) y = below
  else y = clamp(above, wa.y + 8, wa.y + wa.height - PEEK_H - 8)
  return { x, y: clamp(y, wa.y + 8, wa.y + wa.height - PEEK_H - 8) }
}

/** 显示并推数据；页面还没加载好就先等它加载完 */
export function showPeekWith(data: unknown): void {
  const win = peek ?? createPeek()
  if (!win || win.isDestroyed()) return

  const { x, y } = peekBounds()
  win.setBounds({ x, y, width: PEEK_W, height: PEEK_H })

  const reveal = (): void => {
    if (!win || win.isDestroyed()) return
    win.webContents.send(IPC.peekData, data)
    win.showInactive()
    if (peekTimer) clearTimeout(peekTimer)
    peekTimer = setTimeout(() => hidePeek(), 12_000)
  }

  if (win.webContents.isLoadingMainFrame()) {
    win.webContents.once('did-finish-load', () => reveal())
  } else {
    reveal()
  }
}

export function hidePeek(): void {
  if (peekTimer) {
    clearTimeout(peekTimer)
    peekTimer = null
  }
  if (peek && !peek.isDestroyed() && peek.isVisible()) peek.hide()
}

export function peekVisible(): boolean {
  return Boolean(peek && !peek.isDestroyed() && peek.isVisible())
}

/* ------------------------------------------------------------------ 特效层 */
let overlayWin: BrowserWindow | null = null

export function getOverlay(): BrowserWindow | null {
  return overlayWin
}

/**
 * 屏幕顶部的状态特效层：铺满全屏、永远鼠标穿透、不抢焦点。
 * 只在需要时显示，隐藏时完全不吃性能。
 */
export function createOverlay(): BrowserWindow {
  // 铺满整个虚拟桌面（多屏时取所有屏幕的外接矩形），特效才会出现在「屏幕的四条边」
  const displays = screen.getAllDisplays()
  const minX = Math.min(...displays.map((d) => d.bounds.x))
  const minY = Math.min(...displays.map((d) => d.bounds.y))
  const maxX = Math.max(...displays.map((d) => d.bounds.x + d.bounds.width))
  const maxY = Math.max(...displays.map((d) => d.bounds.y + d.bounds.height))
  const x = minX
  const y = minY
  const width = maxX - minX
  const height = maxY - minY
  overlayWin = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: preloadPath(),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  overlayWin.setAlwaysOnTop(true, 'screen-saver')
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // 永远穿透：这层只是画特效，绝不能抢鼠标
  overlayWin.setIgnoreMouseEvents(true, { forward: false })

  overlayWin.once('ready-to-show', () => {
    /* 首帧准备好再允许显示，避免出现白底一帧 */
  })
  loadPage(overlayWin, 'overlay')
  return overlayWin
}

export function getPanel(): BrowserWindow | null {
  return panel
}

function overlapsPanel(a: { x: number; y: number; width: number; height: number }, b: Electron.Rectangle, margin: number): boolean {
  return !(
    a.x + a.width + margin <= b.x ||
    b.x + b.width + margin <= a.x ||
    a.y + a.height + margin <= b.y ||
    b.y + b.height + margin <= a.y
  )
}

function anchorBounds(): { x: number; y: number } {
  const ballBounds = ball?.getBounds()
  if (!ballBounds) {
    const wa = screen.getPrimaryDisplay().workArea
    return { x: wa.x + wa.width - PANEL_W - 20, y: wa.y + 80 }
  }
  const display = screen.getDisplayNearestPoint({
    x: ballBounds.x + Math.round(ballBounds.width / 2),
    y: ballBounds.y + Math.round(ballBounds.height / 2)
  })
  const wa = display.workArea
  const gap = 12
  const cx = ballBounds.x + Math.round(ballBounds.width / 2)

  const x = clamp(cx - Math.round(PANEL_W / 2), wa.x + 8, wa.x + wa.width - PANEL_W - 8)
  const minX = wa.x + 8
  const maxX = wa.x + wa.width - PANEL_W - 8
  const minY = wa.y + 8
  const maxY = wa.y + wa.height - PANEL_H - 8
  const fits = (xx: number, yy: number): boolean =>
    !overlapsPanel({ x: xx, y: yy, width: PANEL_W, height: PANEL_H }, ballBounds, gap)
  const sideY = (top: boolean): number =>
    top ? ballBounds.y - PANEL_H - gap : ballBounds.y + ballBounds.height + gap

  const preferTop = ballBounds.y + ballBounds.height / 2 > wa.y + wa.height / 2

  // ① 优先上下贴球（球在屏幕下半就放上方，反之放下方）
  for (const top of [preferTop, !preferTop]) {
    const yy = clamp(sideY(top), minY, maxY)
    if (fits(x, yy)) return { x, y: yy }
  }
  // ② 上下都让不开（球停在屏幕中间）：挪到球的左右
  const sideX = [ballBounds.x - PANEL_W - gap, ballBounds.x + ballBounds.width + gap]
  for (const top of [preferTop, !preferTop]) {
    const yy = clamp(sideY(top), minY, maxY)
    for (const raw of sideX) {
      const xx = clamp(raw, minX, maxX)
      if (fits(xx, yy)) return { x: xx, y: yy }
    }
  }
  // ③ 屏幕太小实在塞不下，退回最合理的一侧（至少不会盖住球的中心）
  return { x, y: clamp(sideY(preferTop), minY, maxY) }
}

export function showPanel(): void {
  if (!panel) return
  const { x, y } = anchorBounds()
  const already = panel.isVisible()
  logInfo('showPanel', `x=${x} y=${y} already=${already}`)
  panel.setBounds({ x, y, width: PANEL_W, height: PANEL_H })
  if (!already) {
    // 只有真正从隐藏到显示时才做透明淡入；
    // 已经开着还去 setOpacity(0) 再拉回来，就是「唤醒后闪一下」的来源
    try {
      panel.setOpacity(0)
    } catch {
      /* ignore */
    }
    panel.show()
    setTimeout(() => {
      try {
        if (panel && !panel.isDestroyed()) panel.setOpacity(1)
      } catch {
        /* ignore */
      }
    }, 50)
  }
  panel.setSkipTaskbar(true)
  panel.focus()
  logInfo('showPanel done', 'visible=' + String(panel.isVisible()))
  panel.webContents.send('panel:shown')
}

export function hidePanel(): void {
  logInfo('hidePanel')
  panel?.hide()
}

export function togglePanel(): void {
  if (!panel) return
  const visible = panel.isVisible()
  logInfo('togglePanel', `visible=${visible}`)
  if (visible) hidePanel()
  else showPanel()
}





