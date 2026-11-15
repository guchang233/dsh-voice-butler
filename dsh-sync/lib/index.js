import fs from 'node:fs'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * dsh-butler-shell —— 语音壳的守护者。
 *
 * 只做两件事：
 *   1. DSH 起来时，把桌面上的语音壳（Electron「管家」）一起拉起来；
 *   2. 把壳需要知道的东西写进 ~/.dsh/butler-bridge/shell.json（DSH 地址等）。
 *
 * 它不碰对话：识别、回话、工具全在 butler-bridge 和管家会话里。
 *
 * 应用目录默认是本插件上一级的 app/。要换位置就设 BUTLER_APP_DIR。
 */

export const name = 'dsh-butler-sync'
export const inject = ['webServer']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP_DIR = process.env.BUTLER_APP_DIR || path.resolve(HERE, '../../app')
const APP_EXE = path.join(APP_DIR, 'dist', 'win-unpacked', '管家.exe')
const DEV_EXE = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe')
const STATE_DIR = path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'butler-bridge')
const SHELL_FILE = path.join(STATE_DIR, 'shell.json')
const PID_FILE = path.join(STATE_DIR, 'shell.pid')

/**
 * @param {string} cmd
 * @param {string[]} args
 * @returns {Promise<string>}
 */
function execFileAsync(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 8000 }, (error, stdout) => {
      resolve(error ? '' : String(stdout ?? ''))
    })
  })
}

/** @param {number} pid */
function pidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 打包后的「管家.exe」、上次拉起记下的 pid、或者开发模式里已经在跑这个目录的 electron，都算已经在运行。
 * 开发模式如果只看 管家.exe，每次 DSH 重载都会再拉起一个 electron。
 */
async function alreadyRunning() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim())
    if (pidAlive(pid)) return true
  } catch {
    /* 还没有 pid 文件 */
  }
  const listed = await execFileAsync('tasklist', ['/FI', 'IMAGENAME eq 管家.exe', '/NH'])
  if (listed.includes('管家.exe')) return true
  const lines = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name = 'electron.exe'\" | Select-Object -ExpandProperty CommandLine"
  ])
  return lines.toLowerCase().includes(APP_DIR.toLowerCase())
}

/** 壳读这个文件找 DSH；bridge 会刷新 endpoint.json，这里补一份壳自己的配置 */
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

/**
 * @param {{ info?: Function, warn?: Function }} logger
 * @param {string} origin
 */
async function launchShell(logger, origin) {
  try {
    if (await alreadyRunning()) {
      logger?.info?.('[butler-shell] 语音壳已在运行，不再拉起')
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
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true })
      if (child.pid) fs.writeFileSync(PID_FILE, String(child.pid), 'utf8')
    } catch {
      /* pid 记不住也不影响这次拉起 */
    }
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
  void launchShell(logger, origin)

  ctx.on('dispose', () => {
    /* 壳自己活着，DSH 退出不杀它：托盘里还能手动关 */
  })
}
