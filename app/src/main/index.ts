import { app, globalShortcut, Menu, nativeImage, nativeTheme, session, Tray } from 'electron'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { getBridge } from './bridge'
import { registerIpc } from './ipc'
import { installCrashLogging, logError, logInfo } from './log'
import { runWakeWordSelfTest } from './audio/selftest'
import { buildPeekData } from './peek'
import { lockOverlayMode } from './overlay'
import { getSettings, savePreferences } from './store'
import { getVoice } from './voice'
import { SKINS, IPC } from '../shared/ipc'
import {
  broadcastSkin,
  createBall,
  createOverlay,
  createPanel,
  getBall,
  getPanel,
  hidePanel,
  markQuitting,
  showPanel,
  showPeekWith,
  togglePanel
} from './windows'

/**
 * 「管家」语音壳。
 *
 * 它只做三件事：听（唤醒词 + 录音 + 识别）、说（把 DSH 的回话念出来）、显示（把 DSH 的
 * 会话过程铺到面板上）。想和做都在 DSH 的管家会话里，本进程不持有任何对话状态。
 */

/** 调试：读 userData\overlay-mode.txt 里的模式名，读完即删（一次性的） */
function readOverlayModeHint(): string {
  try {
    const file = join(app.getPath('userData'), 'overlay-mode.txt')
    if (!existsSync(file)) return ''
    const text = readFileSync(file, 'utf8').trim()
    try {
      rmSync(file)
    } catch {
      /* ignore */
    }
    return text
  } catch {
    return ''
  }
}

installCrashLogging()
// 透明窗口在部分 Windows 驱动上会因遮挡判定而停画
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
// 让 AudioContext 不用等用户手势就能跑（麦克风采集与 TTS 播放都靠它）
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

app.setAppUserModelId('com.aibutler.voice')

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showPanel()
    getBall()?.showInactive()
  })
  void bootstrap().catch((error) => logError('bootstrap', error))
}

let tray: Tray | null = null

function trayIconPath(): string {
  const packaged = join(process.resourcesPath, 'tray.png')
  const dev = join(app.getAppPath(), 'resources', 'tray.png')
  return app.isPackaged ? packaged : dev
}

function buildTray(): void {
  const file = trayIconPath()
  const image = existsSync(file) ? nativeImage.createFromPath(file) : nativeImage.createEmpty()

  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image)
  tray.setToolTip('管家')
  const menu = Menu.buildFromTemplate([
    { label: '打开面板', click: () => showPanel() },
    { label: '收起面板', click: () => hidePanel() },
    { type: 'separator' },
    {
      label: '叫醒她（等价于喊唤醒词）',
      click: () => {
        getVoice().wakeByHand()
      }
    },
    {
      label: '在 DSH 里开一条新会话',
      click: () => {
        void getBridge()
          .newSession()
          .catch((error) => logError('tray.newSession', error))
      }
    },
    { type: 'separator' },
    {
      label: '换肤',
      submenu: SKINS.map((skin) => ({
        label: skin.label,
        type: 'radio' as const,
        checked: getSettings().skin === skin.key,
        click: () => {
          savePreferences({ skin: skin.key })
          broadcastSkin(skin.key)
        }
      }))
    },
    {
      label: '开机启动',
      type: 'checkbox' as const,
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item: { checked: boolean }) => {
        app.setLoginItemSettings({
          openAtLogin: item.checked,
          path: process.execPath,
          args: app.isPackaged ? [] : [app.getAppPath()]
        })
        logInfo('autostart', String(item.checked))
      }
    },
    {
      label: '开关悬浮球',
      click: () => {
        const ball = getBall()
        if (!ball) return
        if (ball.isVisible()) ball.hide()
        else ball.showInactive()
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        markQuitting()
        app.quit()
      }
    }
  ])
  tray.setContextMenu(menu)
  tray.on('click', () => togglePanel())
}

/** 把 DSH 推来的东西分给面板和语音层 */
function wireBridge(): void {
  const voice = getVoice()
  const bridge = getBridge()

  const toPanel = (channel: string, payload: unknown): void => {
    const panel = getPanel()
    if (panel && !panel.isDestroyed()) panel.webContents.send(channel, payload)
  }

  bridge.start({
    frame: (frame) => {
      toPanel(IPC.voiceFrame, frame)
      voice.handleFrame(frame)
    },
    history: (frames) => {
      toPanel(IPC.voiceHistory, frames)
      voice.handleHistory(frames)
    },
    reset: () => toPanel(IPC.voiceReset, null),
    link: (link, origin) => {
      toPanel(IPC.linkState, { link, origin })
      voice.handleLink(link)
      if (tray) tray.setToolTip(link === 'online' ? '管家 · 已连上 DSH' : '管家 · 未连上 DSH')
    }
  })
}

async function bootstrap(): Promise<void> {
  await app.whenReady()
  logInfo('ready')

  // 麦克风权限：本机桌面应用，直接放行采集（不弹 Chromium 的授权条）
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media' || permission === ('audioCapture' as typeof permission))
  })
  session.defaultSession.setPermissionCheckHandler(() => true)

  const settings = getSettings()
  logInfo('settings', JSON.stringify({ ...settings, hasKey: settings.hasKey }))

  // 主题：设置里的「纸/墨/跟随系统」，三个窗口一起跟着变
  nativeTheme.themeSource = settings.theme

  createBall(settings.ballPosition)
  createPanel()
  createOverlay()
  registerIpc()
  buildTray()

  try {
    getVoice().start()
  } catch (error) {
    logError('voice start', error)
  }
  wireBridge()

  app.on('activate', () => {
    if (!getBall()) createBall(getSettings().ballPosition)
    if (!getPanel()) createPanel()
  })

  globalShortcut.register('Control+Alt+H', () => togglePanel())
  globalShortcut.register('Control+Alt+J', () => getVoice().wakeByHand())
  logInfo(
    'shortcut',
    'Ctrl+Alt+H=' + String(globalShortcut.isRegistered('Control+Alt+H')) +
      ' Ctrl+Alt+J=' + String(globalShortcut.isRegistered('Control+Alt+J'))
  )

  // 调试用：把面板直接打开
  if (process.env['BUTLER_OPEN_PANEL'] === '1') setTimeout(() => showPanel(), 400)
  // 调试用：强制纸/墨主题
  const theme = process.env['BUTLER_THEME']
  if (theme === 'light' || theme === 'dark') nativeTheme.themeSource = theme
  // 调试用：把顶层特效钉在某个模式（wake / think / act / mouse），核对配色和强度。
  // 优先级：环境变量 > userData\overlay-mode.txt（文件读完即删，不会卡住不出特效）
  const overlayMode = process.env['BUTLER_OVERLAY_MODE'] || readOverlayModeHint()
  if (overlayMode && ['wake', 'think', 'act', 'mouse'].includes(overlayMode)) {
    setTimeout(() => lockOverlayMode(overlayMode as 'wake' | 'think' | 'act' | 'mouse'), 1200)
  }
  // 调试用：直接弹一次「时段 + 余额」小卡片（等价于右键悬浮球）
  if (process.env['BUTLER_PEEK'] === '1') {
    setTimeout(() => {
      void buildPeekData()
        .then((data) => showPeekWith(data))
        .catch((error) => logError('peek', error))
    }, 2000)
  }
  // 调试用：本地念一句（不进 DSH），验证 TTS 链路
  if (process.env['BUTLER_SAY']) {
    setTimeout(() => getVoice().speakNow(process.env['BUTLER_SAY'] as string), 1500)
  }
  // 调试用：云端念一遍唤醒词 → 灌回本地唤醒词引擎 → 再送 ASR，验证三环
  if (process.env['BUTLER_KWS_SELFTEST'] === '1') {
    setTimeout(() => {
      void runWakeWordSelfTest()
    }, 800)
  }
  // 调试用：不经麦克风，直接把一句话投进 DSH
  if (process.env['BUTLER_TYPED']) {
    setTimeout(() => {
      void getVoice()
        .deliver(process.env['BUTLER_TYPED'] as string)
        .catch((error) => logError('typed', error))
    }, 2500)
  }
}

app.on('window-all-closed', () => {
  // 常驻托盘，不退出
})

app.on('before-quit', () => {
  markQuitting()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  tray?.destroy()
  tray = null
})
