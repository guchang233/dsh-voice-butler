import fs from 'node:fs'
import path from 'node:path'
import { execSync, spawn } from 'node:child_process'

/**
 * dsh-butler-shell —— 语音壳的守护者。
 *
 * 只做两件事：
 *   1. DSH 起来时，把桌面上的语音壳（Electron「管家」）一起拉起来；
 *   2. 把壳需要知道的东西写进 ~/.dsh/butler-bridge/shell.json（DSH 地址等）。
 *
 * 它不碰对话：识别、回话、工具全在 butler-bridge 和管家会话里。
 */

export const name = 'dsh-butler-sync'
export const inject = ['webServer']

const APP_DIR = process.env.BUTLER_APP_DIR || 'D:\\AI\\ClaudeCode\\语音管家\\app'
const APP_EXE = path.join(APP_DIR, 'dist', 'win-unpacked', '管家.exe')
const DEV_EXE = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe')
const STATE_DIR = path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'butler-bridge')
const SHELL_FILE = path.join(STATE_DIR, 'shell.json')

function alreadyRunning() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq 管家.exe" /NH', { encoding: 'utf8' })
    return out.includes('管家.exe')
  } catch {
    return false
  }
}

/** 壳读这个文件找 DSH；bridge 每 20 秒刷新 endpoint.json，这里补一份壳自己的配置 */
function writeShellConfig(origin) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.writeFileSync(
      SHELL_FILE,
      JSON.stringify(
        {
          origin: origin || '',
          appDir: APP_DIR,
          autoWake: true,
          updatedAt: Date.now()
        },
        null,
        2
      ),
      'utf8'
    )
  } catch {
    /* 写不进去不影响启动 */
  }
}

function launchShell(logger, origin) {
  try {
    if (alreadyRunning()) {
      logger?.info?.('[butler-shell] 语音壳已在运行')
      return
    }
    const exe = fs.existsSync(APP_EXE) ? APP_EXE : fs.existsSync(DEV_EXE) ? DEV_EXE : null
    if (!exe) {
      logger?.warn?.(`[butler-shell] 找不到语音壳可执行文件：${APP_EXE}`)
      return
    }
    const env = { ...process.env }
    // 带着 ELECTRON_RUN_AS_NODE 会把 Electron 当 node 跑，启动即退出
    delete env.ELECTRON_RUN_AS_NODE
    if (origin) env.BUTLER_DSH_ORIGIN = origin

    const child = spawn(exe, exe === DEV_EXE ? ['.'] : [], {
      cwd: APP_DIR,
      detached: true,
      stdio: 'ignore',
      env
    })
    child.unref()
    logger?.info?.('[butler-shell] 已拉起语音壳：' + exe)
  } catch (error) {
    logger?.warn?.('[butler-shell] 启动语音壳失败：' + (error?.message ?? error))
  }
}

export function apply(ctx) {
  const logger = ctx.logger ?? console

  let origin = ''
  try {
    origin = ctx.webServer.getOrigin()
  } catch {
    origin = ''
  }

  writeShellConfig(origin)
  launchShell(logger, origin)

  ctx.on('dispose', () => {
    /* 壳自己活着，DSH 退出不杀它：托盘里还能手动关 */
  })
}
