import type { VoiceFrame } from '../../shared/ipc'

export type Item =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean; interrupted?: boolean }
  | { kind: 'tool'; id: string; name: string; args: string; ok: boolean | null; detail?: string }
  | { kind: 'notice'; id: string; tone: 'error' | 'info'; text: string }

export type ToolItem = Extract<Item, { kind: 'tool' }>

export type ThreadRow =
  | { kind: 'bubble'; item: Item; key: string }
  | { kind: 'tools'; items: ToolItem[]; key: string }

/** 长对话只留最近这些条，更早的在 DSH 会话里 */
export const MAX_THREAD = 240

const uid = (): string => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4)

let frameSeq = 0
export const nextId = (): string => `${++frameSeq}-${uid()}`

export function capThread(items: Item[]): Item[] {
  if (items.length <= MAX_THREAD) return items
  return items.slice(items.length - MAX_THREAD)
}

function finalize(item: Item): Item {
  return item.kind === 'assistant' && item.streaming ? { ...item, streaming: false } : item
}

/** 把一帧翻译成列表里的变化 */
export function applyFrame(items: Item[], frame: VoiceFrame, streamId: { current: string | null }): Item[] {
  switch (frame.t) {
    case 'user': {
      streamId.current = null
      return capThread([...items.map(finalize), { kind: 'user', id: nextId(), text: frame.text }])
    }
    case 'delta': {
      if (!frame.text) return items
      if (streamId.current) {
        const idx = items.findIndex((item) => item.id === streamId.current)
        if (idx >= 0) {
          const next = items.slice()
          const current = next[idx]
          if (current.kind === 'assistant') {
            next[idx] = { ...current, text: current.text + frame.text, streaming: true }
          }
          return next
        }
      }
      const id = nextId()
      streamId.current = id
      return capThread([...items, { kind: 'assistant', id, text: frame.text, streaming: true }])
    }
    case 'reply': {
      const text = frame.text ?? ''
      const id = streamId.current
      streamId.current = null
      if (id) {
        const idx = items.findIndex((item) => item.id === id)
        if (idx >= 0) {
          const next = items.slice()
          next[idx] = {
            kind: 'assistant',
            id,
            text: text || (next[idx] as { text: string }).text,
            streaming: false,
            interrupted: frame.interrupted
          }
          return next
        }
      }
      if (!text) return items
      return capThread([
        ...items,
        { kind: 'assistant', id: nextId(), text, streaming: false, interrupted: frame.interrupted }
      ])
    }
    case 'tool': {
      if (frame.phase === 'start') {
        return capThread([
          ...items,
          { kind: 'tool', id: frame.id || nextId(), name: frame.name, args: frame.args ?? '', ok: null }
        ])
      }
      const idx = items.findIndex((item) => item.kind === 'tool' && item.id === frame.id)
      if (idx >= 0) {
        const next = items.slice()
        const current = next[idx]
        if (current.kind === 'tool') {
          next[idx] = { ...current, ok: frame.ok === true, detail: frame.detail ?? '' }
        }
        return next
      }
      return capThread([
        ...items,
        {
          kind: 'tool',
          id: frame.id || nextId(),
          name: frame.name || '工具',
          args: '',
          ok: frame.ok === true,
          detail: frame.detail ?? ''
        }
      ])
    }
    case 'error':
      return capThread([...items, { kind: 'notice', id: nextId(), tone: 'error', text: frame.message }])
    default:
      return items
  }
}

/** 连续的工具调用收成一行时间线 */
export function groupThread(items: Item[]): ThreadRow[] {
  const rows: ThreadRow[] = []
  let bucket: ToolItem[] = []
  const flush = (): void => {
    if (!bucket.length) return
    rows.push({ kind: 'tools', items: bucket, key: `tools-${bucket[0].id}` })
    bucket = []
  }
  for (const item of items) {
    if (item.kind === 'tool') bucket.push(item)
    else {
      flush()
      rows.push({ kind: 'bubble', item, key: item.id })
    }
  }
  flush()
  return rows
}

export function rowExtent(row: ThreadRow, expanded: boolean): number {
  if (row.kind === 'tools') return expanded ? 40 + row.items.length * 28 : 44
  if (row.item.kind === 'notice') return 40
  const text = row.item.kind === 'user' || row.item.kind === 'assistant' ? row.item.text : ''
  const lines = Math.max(1, Math.ceil(text.length / 22))
  return Math.min(240, 28 + lines * 22)
}
