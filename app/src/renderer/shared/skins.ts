import whaleUrl from './skins/whale.png'
import niang02Url from './skins/niang02.png'

/** 换肤 = 换这只鱼的贴图。内置两张，其余由用户自己导入。 */
export const SKIN_LIST: Array<{ key: string; label: string; url: string }> = [
  { key: 'whale', label: '鲸鱼娘', url: whaleUrl },
  { key: 'niang02', label: '鲸鱼娘 · 02', url: niang02Url }
]

let custom: Array<{ key: string; label: string; url: string }> = []
let loaded = false
const listeners = new Set<() => void>()

export function allSkins(): Array<{ key: string; label: string; url: string }> {
  return [...SKIN_LIST, ...custom]
}

export function skinUrl(key: string): string {
  return allSkins().find((item) => item.key === key)?.url ?? SKIN_LIST[0].url
}

export function skinLabel(key: string): string {
  return allSkins().find((item) => item.key === key)?.label ?? '鲸鱼娘'
}

export function subscribeSkins(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

function publish(): void {
  for (const fn of listeners) fn()
}

/** 首次拉一次用户贴图（模块级去重，组件多也不会重复请求） */
export async function ensureSkinsLoaded(): Promise<void> {
  if (loaded) return
  loaded = true
  try {
    custom = await window.api.getSkinCatalog()
    publish()
  } catch {
    /* 忽略 */
  }
}

/** 导入/删除后强制刷新 */
export async function refreshSkins(): Promise<void> {
  try {
    custom = await window.api.getSkinCatalog()
    loaded = true
    publish()
  } catch {
    /* 忽略 */
  }
}
