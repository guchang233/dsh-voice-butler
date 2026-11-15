import { app } from 'electron'
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const MAX_BYTES = 2 * 1024 * 1024

const logPath = (): string => join(app.getPath('userData'), 'main.log')

let chain: Promise<void> = Promise.resolve()

async function rotate(file: string): Promise<void> {
  try {
    const info = await stat(file)
    if (info.size < MAX_BYTES) return
    await rename(file, `${file}.1`)
  } catch {
    /* 还没有日志，或者上一份 .1 正在被占用 */
  }
}

function write(level: string, parts: unknown[]): void {
  const line = `[${new Date().toISOString()}] ${level} ${parts
    .map((part) => (part instanceof Error ? `${part.name}: ${part.message}\n${part.stack ?? ''}` : String(part)))
    .join(' ')}\n`
  chain = chain
    .then(async () => {
      const file = logPath()
      await mkdir(dirname(file), { recursive: true })
      await rotate(file)
      await appendFile(file, line, 'utf8')
    })
    .catch(() => undefined)
}

export const logInfo = (...parts: unknown[]): void => write('INFO', parts)
export const logError = (...parts: unknown[]): void => write('ERROR', parts)

export function installCrashLogging(): void {
  process.on('uncaughtException', (error) => logError('uncaughtException', error))
  process.on('unhandledRejection', (reason) => logError('unhandledRejection', reason))
}
