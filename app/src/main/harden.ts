import type { BrowserWindow, WebContents } from 'electron'

/** 只允许应用自己的页面：打包后的 file、开发服务器、贴图协议 */
export function isAppUrl(url: string): boolean {
  if (!url) return true
  if (url.startsWith('file:')) return true
  const dev = process.env['ELECTRON_RENDERER_URL']
  if (dev && (url === dev || url.startsWith(`${dev}/`) || url.startsWith(dev))) return true
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'butler-skin:') return true
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
  } catch {
    return false
  }
}

export function isLocalContents(contents: WebContents | null): boolean {
  if (!contents) return false
  try {
    return isAppUrl(contents.getURL())
  } catch {
    return false
  }
}

/** 禁止跳出应用、禁止再开窗口 */
export function hardenWindow(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault()
  })
  win.webContents.on('will-redirect', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault()
  })
}

export function contentSecurityPolicy(): string {
  const dev = Boolean(process.env['ELECTRON_RENDERER_URL'])
  if (dev) {
    return [
      "default-src 'self' blob:",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: butler-skin:",
      "media-src 'self' blob: mediastream:",
      "connect-src 'self' ws: wss: http://localhost:* http://127.0.0.1:* https://api.deepseek.com",
      "worker-src 'self' blob:",
      "font-src 'self' data:"
    ].join('; ')
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: butler-skin:",
    "media-src 'self' blob: mediastream:",
    "connect-src 'self' https://api.deepseek.com",
    "worker-src 'self' blob:",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'"
  ].join('; ')
}
