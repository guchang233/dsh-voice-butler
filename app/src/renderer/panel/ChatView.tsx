import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { AlertTriangle, CornerDownLeft, Loader2, Mic, Search, ShieldCheck, Wrench, X } from 'lucide-react'
import { WAKE_WORD, type LinkState, type PublicSettings } from '../../shared/ipc'
import { isDangerousApproval } from '../../shared/confirm'
import { SkinImage } from '../shared/SkinImage'
import { groupThread, rowExtent, type Item, type ThreadRow } from './thread'

type Props = {
  items: Item[]
  approval: { id: string; tool: string; reason: string } | null
  link: LinkState
  settings: PublicSettings | null
  input: string
  setInput: (value: string) => void
  onSend: () => void
  onApprove: (allow: boolean) => void
  inputRef: RefObject<HTMLInputElement>
}

export default function ChatView({
  items,
  approval,
  link,
  settings,
  input,
  setInput,
  onSend,
  onApprove,
  inputRef,
}: Props): JSX.Element {
  const [holding, setHolding] = useState(false)
  const [openTools, setOpenTools] = useState<Record<string, boolean>>({})
  const rows = useMemo(() => groupThread(items), [items])

  const release = (): void => {
    if (!holding) return
    setHolding(false)
    window.api.ptt(false)
  }

  return (
    <>
      <VirtualThread
        rows={rows}
        openTools={openTools}
        stick={items.length}
        empty={
          <div className="empty">
            <SkinImage className="empty-char" />
            <p className="pane-title">说一句试试</p>
            <p className="pane-hint">喊一声「{settings?.wakeWord ?? WAKE_WORD}」，按住左边的话筒，或者直接打字。</p>
            <div className="chips">
              {['现在几点了', '打开记事本', '把音量调到一半', '今天有什么安排'].map((hint) => (
                <button key={hint} type="button" className="chip" onClick={() => setInput(hint)}>
                  {hint}
                </button>
              ))}
            </div>
          </div>
        }
      >
        {(row) =>
          row.kind === 'tools' ? (
            <ToolTimeline
              row={row}
              open={openTools[row.key] === true}
              onToggle={() => setOpenTools((prev) => ({ ...prev, [row.key]: !prev[row.key] }))}
            />
          ) : (
            <Bubble item={row.item} />
          )
        }
      </VirtualThread>

      {approval && (
        <div
          className={isDangerousApproval(approval.tool, approval.reason) ? 'confirm-sheet is-danger' : 'confirm-sheet'}
        >
          <div className="confirm-head">
            <ShieldCheck size={15} strokeWidth={1.8} />
            <span>{isDangerousApproval(approval.tool, approval.reason) ? '危险操作，请在这里点' : '需要你点头'}</span>
          </div>
          <p className="confirm-text">{approval.reason || approval.tool || '这一步会改动系统'}</p>
          <div className="confirm-actions">
            <button className="btn btn-primary btn-sm" onClick={() => onApprove(true)}>
              允许
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => onApprove(false)}>
              取消
            </button>
          </div>
          <p className="confirm-hint">危险操作请在这里点允许；说「取消」可以拒绝。</p>
        </div>
      )}

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault()
          onSend()
        }}
      >
        <div className="search-bar">
          <button
            type="button"
            className={holding ? 'ptt is-down' : 'ptt'}
            aria-label="按住说话"
            title="按住说话"
            onPointerDown={(event) => {
              event.preventDefault()
              setHolding(true)
              window.api.ptt(true)
            }}
            onPointerUp={release}
            onPointerCancel={release}
            onPointerLeave={release}
          >
            <Mic size={16} strokeWidth={1.8} />
          </button>
          <div className="search-field">
            <span className="search-leading">
              <Search size={16} strokeWidth={1.6} />
            </span>
            <input
              ref={inputRef}
              className="search-input"
              type="text"
              placeholder={link === 'offline' ? 'DSH 没连上，先把它打开' : '和管家说点什么…'}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  onSend()
                }
              }}
              spellCheck={false}
            />
            {input && (
              <button type="button" className="search-clear" aria-label="清空输入" onClick={() => setInput('')}>
                <X size={14} strokeWidth={1.8} />
              </button>
            )}
          </div>
          <button type="submit" className="search-submit" disabled={!input.trim() || link === 'offline'}>
            <CornerDownLeft size={13} strokeWidth={2} />
            发送
          </button>
        </div>
      </form>
    </>
  )
}

function Bubble({ item }: { item: Item }): JSX.Element {
  if (item.kind === 'notice') {
    return (
      <div className="tool-row">
        <span className="tool-icon">
          <AlertTriangle size={13} />
        </span>
        <span className="tool-fail">{item.text}</span>
      </div>
    )
  }
  if (item.kind === 'tool') return <div />
  const streaming = item.kind === 'assistant' && item.streaming
  return (
    <div className={`row ${item.kind === 'user' ? 'user' : 'assistant'}`}>
      <div className="bubble">
        <span className="bubble-text">
          {item.text || (streaming ? '' : '（空）')}
          {streaming && <i className="caret" />}
        </span>
      </div>
    </div>
  )
}

function ToolTimeline({
  row,
  open,
  onToggle,
}: {
  row: Extract<ThreadRow, { kind: 'tools' }>
  open: boolean
  onToggle: () => void
}): JSX.Element {
  const last = row.items[row.items.length - 1]
  const busy = row.items.some((item) => item.ok === null)
  const failed = row.items.some((item) => item.ok === false)
  return (
    <div className="tool-timeline">
      <button type="button" onClick={onToggle}>
        <span className={busy ? 'tool-icon busy' : 'tool-icon'}>
          {busy ? <Loader2 size={13} className="spin" /> : failed ? <AlertTriangle size={13} /> : <Wrench size={13} />}
        </span>
        <span className="tool-text">
          {row.items.length} 个工具 · {last?.name || '工具'}
          {last?.args ? ` · ${last.args}` : ''}
        </span>
        <span className="tool-fold">{open ? '收起' : '展开'}</span>
      </button>
      {open && (
        <div className="tool-detail">
          {row.items.map((item) => (
            <div key={item.id} className="tool-text">
              {item.ok === false ? '失败' : item.ok === null ? '进行中' : '完成'} · {item.name || '工具'}
              {item.args ? ` · ${item.args}` : ''}
              {item.ok === false && item.detail ? ` · ${item.detail}` : ''}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function VirtualThread({
  rows,
  openTools,
  stick,
  empty,
  children,
}: {
  rows: ThreadRow[]
  openTools: Record<string, boolean>
  stick: number
  empty: ReactNode
  children: (row: ThreadRow) => ReactNode
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const [scroll, setScroll] = useState(0)
  const [viewport, setViewport] = useState(360)
  const extents = rows.map((row) => rowExtent(row, row.kind === 'tools' && openTools[row.key] === true))
  const offsets: number[] = [0]
  for (const extent of extents) offsets.push((offsets[offsets.length - 1] ?? 0) + extent)
  const total = offsets[offsets.length - 1] ?? 0
  let start = 0
  while (start < rows.length && (offsets[start + 1] ?? 0) < scroll - 100) start += 1
  let end = start
  while (end < rows.length && (offsets[end] ?? 0) < scroll + viewport + 160) end += 1
  if (end === start) end = Math.min(rows.length, start + 1)

  // 贴底才跟着滚：以前每次 stick 变化都硬把 scrollTop 拉到底，
  // 跟用户自己的滚动打架，表现就是到最底端时一顿抽搐
  const stickRef = useRef(true)
  const rafRef = useRef(0)

  useEffect(() => {
    const node = ref.current
    if (!node) return
    if (stickRef.current) node.scrollTop = node.scrollHeight
    setViewport(node.clientHeight || 360)
  }, [stick])

  return (
    <div
      className="thread"
      ref={ref}
      onScroll={(event) => {
        const node = event.currentTarget
        stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24
        if (rafRef.current) return
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = 0
          const el = ref.current
          if (!el) return
          setScroll(el.scrollTop)
          setViewport(el.clientHeight)
        })
      }}
    >
      {rows.length === 0 ? (
        empty
      ) : (
        <div className="thread-spacer" style={{ height: total }}>
          <div className="thread-window" style={{ top: offsets[start] ?? 0 }}>
            {rows.slice(start, end).map(children)}
          </div>
        </div>
      )}
    </div>
  )
}
