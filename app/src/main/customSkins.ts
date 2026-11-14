import { app, dialog } from 'electron'
import { getPanel } from './windows'
import fs from 'node:fs'
import path from 'node:path'
import { logError, logInfo } from './log'

/** 用户自己导入的贴图：存在 userData/skins/ 下，索引在同目录 index.json */
export type CustomSkin = { key: string; label: string }
type IndexRow = CustomSkin & { file: string }

const MAX_BYTES = 12 * 1024 * 1024

const dir = (): string => path.join(app.getPath('userData'), 'skins')
const indexFile = (): string => path.join(dir(), 'index.json')

function readIndex(): IndexRow[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexFile(), 'utf8')) as IndexRow[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeIndex(rows: IndexRow[]): void {
  fs.mkdirSync(dir(), { recursive: true })
  fs.writeFileSync(indexFile(), JSON.stringify(rows, null, 2), 'utf8')
}

function mimeOf(file: string): string {
  const ext = path.extname(file).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  return 'image/png'
}

/** 列出所有自定义贴图，带 data URL（渲染层直接用） */
export function listCustomSkins(): Array<CustomSkin & { url: string }> {
  const rows = readIndex()
  const out: Array<CustomSkin & { url: string }> = []
  for (const row of rows) {
    try {
      const full = path.join(dir(), row.file)
      if (!fs.existsSync(full)) continue
      const buf = fs.readFileSync(full)
      out.push({ key: row.key, label: row.label, url: `data:${mimeOf(full)};base64,${buf.toString('base64')}` })
    } catch (error) {
      logError('customSkins.read', row.file, error)
    }
  }
  return out
}

/** 弹文件选择框，把选中的图片复制进 skins/ 并登记 */
export async function importCustomSkin(): Promise<{ ok: boolean; key?: string; label?: string; error?: string }> {
  const parent = getPanel()
  const picked = parent
    ? await dialog.showOpenDialog(parent, {
        title: '选一张当管家的贴图',
        properties: ['openFile'],
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
      })
    : await dialog.showOpenDialog({
    title: '选一张当管家的贴图',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
  })
  if (picked.canceled || !picked.filePaths.length) return { ok: false, error: 'cancelled' }

  const source = picked.filePaths[0]
  try {
    const stat = fs.statSync(source)
    if (stat.size > MAX_BYTES) return { ok: false, error: '图片太大（上限 12 MB）' }
    fs.mkdirSync(dir(), { recursive: true })
    const key = `user-${Date.now().toString(36)}`
    const file = `${key}${path.extname(source).toLowerCase()}`
    fs.copyFileSync(source, path.join(dir(), file))
    const label = path.basename(source, path.extname(source)).slice(0, 20) || '自定义'
    const rows = readIndex()
    rows.push({ key, label, file })
    writeIndex(rows)
    logInfo('customSkins.import', key, label)
    return { ok: true, key, label }
  } catch (error) {
    logError('customSkins.import', error)
    return { ok: false, error: String((error as Error)?.message ?? error) }
  }
}

export function removeCustomSkin(key: string): boolean {
  try {
    const rows = readIndex()
    const hit = rows.find((row) => row.key === key)
    if (!hit) return false
    fs.rmSync(path.join(dir(), hit.file), { force: true })
    writeIndex(rows.filter((row) => row.key !== key))
    return true
  } catch {
    return false
  }
}

/** 右键改名：只改显示名，键与文件都不动 */
export function renameCustomSkin(key: string, label: string): { ok: boolean; label?: string; error?: string } {
  try {
    const clean = label.replace(/\s+/g, ' ').trim().slice(0, 20)
    if (!clean) return { ok: false, error: '名字不能是空的' }
    const rows = readIndex()
    const hit = rows.find((row) => row.key === key)
    if (!hit) return { ok: false, error: '这张贴图已经不在了' }
    hit.label = clean
    writeIndex(rows)
    logInfo('customSkins.rename', key, clean)
    return { ok: true, label: clean }
  } catch (error) {
    logError('customSkins.rename', error)
    return { ok: false, error: String((error as Error)?.message ?? error) }
  }
}
