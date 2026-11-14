import { app } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const logPath = (): string => join(app.getPath('userData'), 'main.log')

function write(level: string, parts: unknown[]): void {
  const line = `[${new Date().toISOString()}] ${level} ${parts
    .map((p) => (p instanceof Error ? `${p.name}: ${p.message}\n${p.stack ?? ''}` : String(p)))
    .join(' ')}\n`
  try {
    mkdirSync(dirname(logPath()), { recursive: true })
    appendFileSync(logPath(), line, 'utf8')
  } catch {
    // 日志写不进去也不能影响主流程
  }
}

export const logInfo = (...parts: unknown[]): void => write('INFO', parts)
export const logError = (...parts: unknown[]): void => write('ERROR', parts)

export function installCrashLogging(): void {
  process.on('uncaughtException', (error) => logError('uncaughtException', error))
  process.on('unhandledRejection', (reason) => logError('unhandledRejection', reason))
}
