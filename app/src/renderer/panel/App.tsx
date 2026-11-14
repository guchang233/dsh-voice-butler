import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  AlertTriangle,
  Check,
  CornerDownLeft,
  Loader2,
  Mic,
  MicOff,
  Plus,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  Square,
  Wrench,
  X
} from 'lucide-react'
import {
  WAKE_WORD,
  type LinkState,
  type PublicSettings,
  type VoiceFrame,
  type VoiceState
} from '../../shared/ipc'
import { allSkins, refreshSkins } from '../shared/skins'
import { SkinImage, useSkinTick } from '../shared/SkinImage'

/**
 * 面板只做一件事：把 DSH 管家会话里发生的事显示出来，并把你说的话送进去。
 * 它不会自己回答任何问题——脑子在 DSH 那条「DSH语音管家」会话里。
 */

type Item =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean; interrupted?: boolean }
  | { kind: 'tool'; id: string; name: string; args: string; ok: boolean | null; detail?: string }
  | { kind: 'notice'; id: string; tone: 'error' | 'info'; text: string }

type View = 'chat' | 'settings'

const uid = (): string => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4)

let frameSeq = 0
const nextId = (): string => `${++frameSeq}-${uid()}`

/** 把一帧翻译成列表里的变化；返回新列表 */
function applyFrame(items: Item[], frame: VoiceFrame, streamId: { current: string | null }): Item[] {
  switch (frame.t) {
    case 'user': {
      // 新一轮开始：上一段没说完的助手气泡收尾
      streamId.current = null
      return [...items.map(finalize), { kind: 'user', id: nextId(), text: frame.text }]
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
      return [...items, { kind: 'assistant', id, text: frame.text, streaming: true }]
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
      return [...items, { kind: 'assistant', id: nextId(), text, streaming: false, interrupted: frame.interrupted }]
    }
    case 'tool': {
      if (frame.phase === 'start') {
        return [
          ...items,
          { kind: 'tool', id: frame.id || nextId(), name: frame.name, args: frame.args ?? '', ok: null }
        ]
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
      return [
        ...items,
        {
          kind: 'tool',
          id: frame.id || nextId(),
          name: frame.name || '工具',
          args: '',
          ok: frame.ok === true,
          detail: frame.detail ?? ''
        }
      ]
    }
    case 'error':
      return [...items, { kind: 'notice', id: nextId(), tone: 'error', text: frame.message }]
    default:
      return items
  }
}

function finalize(item: Item): Item {
  return item.kind === 'assistant' && item.streaming ? { ...item, streaming: false } : item
}

export default function App(): JSX.Element {
  const [settings, setSettings] = useState<PublicSettings | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [input, setInput] = useState('')
  const [view, setView] = useState<View>('chat')
  const [notice, setNotice] = useState<string | null>(null)
  const [voiceState, setVoiceState] = useState<VoiceState>('idle')
  const [link, setLink] = useState<LinkState>('connecting')
  const [origin, setOrigin] = useState('')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [preset, setPreset] = useState<string | null>(null)
  const [phase, setPhase] = useState('idle')
  const [approval, setApproval] = useState<{ id: string; tool: string; reason: string } | null>(null)
  const [micOn, setMicOn] = useState(true)

  const listRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const streamId = useRef<string | null>(null)

  useSkinTick()

  /* ------------------------------------------------------------ 首屏数据 */

  useEffect(() => {
    void window.api.getSettings().then((value) => {
      setSettings(value)
      setMicOn(value.micEnabled)
      if (!value.hasKey) setView('settings')
    })
    void window.api.status().then((status) => {
      setLink(status.link)
      setOrigin(status.origin)
      setSessionId(status.sessionId)
      setPreset(status.preset)
      setVoiceState(status.state)
    })
  }, [])

  /* -------------------------------------------------------------- 订阅 */

  useEffect(() => {
    const offFrame = window.api.onFrame((frame) => {
      setItems((prev) => applyFrame(prev, frame, streamId))
      if (frame.t === 'state') setPhase(frame.phase)
      if (frame.t === 'hello') {
        if (frame.sessionId) setSessionId(frame.sessionId)
        if (frame.preset) setPreset(frame.preset)
      }
      if (frame.t === 'approval') {
        setApproval({ id: frame.id, tool: frame.tool, reason: frame.reason })
      }
      if (frame.t === 'approval-done') setApproval(null)
      if (frame.t === 'reset') {
        streamId.current = null
        setItems([])
        setApproval(null)
      }
    })
    const offHistory = window.api.onHistory((frames) => {
      setItems((prev) => frames.reduce((acc, frame) => applyFrame(acc, frame, streamId), prev))
    })
    const offReset = window.api.onReset(() => {
      streamId.current = null
      setItems([])
      setApproval(null)
    })
    const offLink = window.api.onLinkState(({ link: next, origin: nextOrigin }) => {
      setLink(next)
      if (nextOrigin) setOrigin(nextOrigin)
    })
    const offVoice = window.api.onVoiceState(({ state }) => setVoiceState(state))
    const offShown = window.api.onPanelShown(() => inputRef.current?.focus())
    return () => {
      offFrame()
      offHistory()
      offReset()
      offLink()
      offVoice()
      offShown()
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') void window.api.hidePanel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const node = listRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [items, approval])

  /* -------------------------------------------------------------- 动作 */

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text) return
    setInput('')
    const result = await window.api.say(text)
    if (!result.ok) {
      setItems((prev) => [
        ...prev,
        { kind: 'notice', id: nextId(), tone: 'error', text: result.error }
      ])
    }
  }, [input])

  const answerApproval = (allow: boolean): void => {
    if (!approval) return
    const id = approval.id
    setApproval(null)
    void window.api.approve(id, allow)
  }

  const statusText = useMemo(() => {
    if (link === 'offline') return 'DSH 没连上'
    if (link === 'connecting') return '正在连 DSH…'
    if (voiceState === 'confirming') return '等你点头…'
    if (voiceState === 'listening') return '在听你说…'
    if (voiceState === 'speaking') return '正在说'
    if (phase === 'tool') return '在动这台电脑'
    if (voiceState === 'thinking' || phase === 'thinking') return '在想'
    if (!settings?.hasKey) return '还没配语音钥匙'
    return `说「${settings?.wakeWord ?? WAKE_WORD}」或按 Ctrl+Alt+H`
  }, [link, voiceState, phase, settings])

  const busy = phase !== 'idle' || voiceState === 'thinking' || voiceState === 'speaking'

  return (
    <div className="shell">
      <div className="card">
        <header className="site-header">
          <SkinImage className="avatar" />
          <div className="who">
            <span className="name">
              管家
              <span className={link === 'online' ? 'link-dot on' : 'link-dot'} title={origin} />
            </span>
            <span className="sub">{statusText}</span>
          </div>
          <button
            className="icon-btn"
            title={micOn ? '关掉麦克风' : '打开麦克风'}
            aria-label={micOn ? '关掉麦克风' : '打开麦克风'}
            onClick={() => {
              const next = !micOn
              setMicOn(next)
              window.api.setMicEnabled(next)
            }}
          >
            {micOn ? <Mic size={16} strokeWidth={1.7} /> : <MicOff size={16} strokeWidth={1.7} />}
          </button>
          <button
            className="icon-btn"
            title="设置"
            aria-label="设置"
            onClick={() => setView(view === 'settings' ? 'chat' : 'settings')}
          >
            <SettingsIcon size={16} strokeWidth={1.7} />
          </button>
          <button
            className="icon-btn"
            title="收起"
            aria-label="收起"
            onClick={() => window.api.hidePanel()}
          >
            <X size={17} strokeWidth={1.7} />
          </button>
        </header>

        {view === 'settings' ? (
          <SettingsView
            settings={settings}
            notice={notice}
            sessionId={sessionId}
            preset={preset}
            origin={origin}
            onSaved={(next, message) => {
              setSettings(next)
              setNotice(message)
              setView('chat')
            }}
          />
        ) : (
          <>
            <div className="browse-header">
              <div className="browse-heading">
                <h1>对话</h1>
                <span className="session-tag" title={sessionId ?? ''}>
                  {preset ? `管家模式 · ${sessionId?.slice(-6) ?? '—'}` : (sessionId?.slice(-6) ?? '未连接')}
                </span>
              </div>
              <div className="browse-actions">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  title="在 DSH 里开一条新的管家会话"
                  onClick={() => {
                    streamId.current = null
                    setItems([])
                    void window.api.newSession()
                  }}
                >
                  <Plus size={13} strokeWidth={2} />
                  新会话
                </button>
                {busy && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => void window.api.stop()}
                  >
                    <Square size={12} strokeWidth={2} />
                    停止
                  </button>
                )}
              </div>
            </div>

            <div className="thread" ref={listRef}>
              {items.length === 0 ? (
                <div className="empty">
                  <SkinImage className="empty-char" />
                  <p className="pane-title">说一句试试</p>
                  <p className="pane-hint">
                    喊一声「{settings?.wakeWord ?? WAKE_WORD}」，或者直接打字。听见的话会被送到 DSH
                    的「DSH语音管家」会话里，想和做都在那儿完成，回话会念给你听。
                  </p>
                  <div className="chips">
                    {['现在几点了', '打开记事本', '把音量调到一半', '今天有什么安排'].map((t) => (
                      <button key={t} type="button" className="chip" onClick={() => setInput(t)}>
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                items.map((item) => {
                  if (item.kind === 'tool') {
                    return (
                      <div key={item.id} className="tool-row">
                        <span className={item.ok === null ? 'tool-icon busy' : 'tool-icon'}>
                          {item.ok === null ? (
                            <Loader2 size={13} className="spin" />
                          ) : item.ok ? (
                            <Wrench size={13} />
                          ) : (
                            <AlertTriangle size={13} />
                          )}
                        </span>
                        <span className="tool-text">
                          {item.name || '工具'}
                          {item.args && <span className="tool-args"> · {item.args}</span>}
                        </span>
                        {item.ok === false && item.detail && (
                          <span className="tool-fail">{item.detail}</span>
                        )}
                      </div>
                    )
                  }
                  if (item.kind === 'notice') {
                    return (
                      <div key={item.id} className="tool-row">
                        <span className="tool-icon">
                          <AlertTriangle size={13} />
                        </span>
                        <span className="tool-fail">{item.text}</span>
                      </div>
                    )
                  }
                  const streaming = item.kind === 'assistant' && item.streaming
                  return (
                    <div key={item.id} className={`row ${item.kind === 'user' ? 'user' : 'assistant'}`}>
                      <div className="bubble">
                        <span className="bubble-text">
                          {item.text || (streaming ? '' : '（空）')}
                          {streaming && <i className="caret" />}
                        </span>
                      </div>
                    </div>
                  )
                })
              )}
            </div>

            {approval && (
              <div className="confirm-sheet">
                <div className="confirm-head">
                  <ShieldCheck size={15} strokeWidth={1.8} />
                  <span>需要你点头</span>
                </div>
                <p className="confirm-text">
                  {approval.reason || approval.tool || '这一步会改动系统'}
                </p>
                <div className="confirm-actions">
                  <button className="btn btn-primary btn-sm" onClick={() => answerApproval(true)}>
                    允许
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => answerApproval(false)}>
                    取消
                  </button>
                </div>
                <p className="confirm-hint">也可以直接说「可以」或「不要」</p>
              </div>
            )}

            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault()
                void send()
              }}
            >
              <div className="search-bar">
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
                        void send()
                      }
                    }}
                    spellCheck={false}
                  />
                  {input && (
                    <button
                      type="button"
                      className="search-clear"
                      aria-label="清空输入"
                      onClick={() => {
                        setInput('')
                        inputRef.current?.focus()
                      }}
                    >
                      <X size={14} strokeWidth={1.8} />
                    </button>
                  )}
                </div>
                <button
                  type="submit"
                  className="search-submit"
                  disabled={!input.trim() || link === 'offline'}
                >
                  <CornerDownLeft size={13} strokeWidth={2} />
                  发送
                </button>
              </div>
            </form>
          </>
        )}

        <nav className="tabbar" aria-label="主标签">
          <button
            type="button"
            className={view === 'chat' ? 'tab is-on' : 'tab'}
            onClick={() => setView('chat')}
          >
            <Mic size={20} strokeWidth={1.65} />
            对话
          </button>
          <button
            type="button"
            className={view === 'settings' ? 'tab is-on' : 'tab'}
            onClick={() => setView('settings')}
          >
            <SettingsIcon size={20} strokeWidth={1.65} />
            设置
          </button>
        </nav>
      </div>
    </div>
  )
}

type SettingsProps = {
  settings: PublicSettings | null
  notice: string | null
  sessionId: string | null
  preset: string | null
  origin: string
  onSaved: (next: PublicSettings, message: string) => void
}

function SettingsView({
  settings,
  notice,
  sessionId,
  preset,
  origin,
  onSaved
}: SettingsProps): JSX.Element {
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(settings?.baseUrl ?? 'https://api.deepseek.com')
  const [dshOrigin, setDshOrigin] = useState(settings?.dshOrigin ?? '')
  const [voice, setVoice] = useState<'stella' | 'tide'>(settings?.ttsVoice ?? 'stella')
  const [skin, setSkin] = useState<string>((settings?.skin as string) ?? 'whale')
  const [bargeIn, setBargeIn] = useState(settings?.bargeIn ?? false)
  const [state, setState] = useState<{ kind: 'idle' | 'busy' | 'ok' | 'bad'; text: string }>({
    kind: 'idle',
    text: ''
  })

  const save = async (): Promise<void> => {
    setState({ kind: 'busy', text: '正在校验…' })
    const result = await window.api.saveSettings({
      apiKey: apiKey.trim() || undefined,
      baseUrl: baseUrl.trim() || undefined,
      dshOrigin: dshOrigin.trim(),
      ttsVoice: voice,
      bargeIn
    })
    if (!result.ok) {
      setState({ kind: 'bad', text: result.error })
      return
    }
    setState({ kind: 'ok', text: '已保存' })
    const next = await window.api.getSettings()
    onSaved(next, '设置已保存')
  }

  const clearKey = async (): Promise<void> => {
    const result = await window.api.saveSettings({ apiKey: '' })
    if (result.ok) {
      const next = await window.api.getSettings()
      onSaved(next, '语音钥匙已清除')
    }
  }

  return (
    <>
      <div className="browse-header">
        <div className="browse-heading">
          <h1>设置</h1>
        </div>
      </div>
      <div className="settings">
        {notice && <div className="toast ok">{notice}</div>}

        <label className="field">
          <span className="field-label">语音钥匙（只用于听写和朗读）</span>
          <input
            className="input"
            type="password"
            placeholder={settings?.hasKey ? '已配置，留空表示不修改' : 'sk-…'}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            spellCheck={false}
          />
          <span className="field-hint">
            对话不再用它——对话在 DSH 里跑。这把 Key 只驱动语音识别与语音合成，保存时用{' '}
            <code>GET /models</code> 校验，不花钱。
          </span>
        </label>

        <label className="field">
          <span className="field-label">DSH 地址</span>
          <input
            className="input"
            placeholder={origin || 'http://127.0.0.1:63563'}
            value={dshOrigin}
            onChange={(event) => setDshOrigin(event.target.value)}
            spellCheck={false}
          />
          <span className="field-hint">
            留空就自动读 DSH 写的 <code>endpoint.json</code>。手动填只在端口固定时用得上。
          </span>
        </label>

        <div className="field">
          <span className="field-label">音色</span>
          <div className="seg-group">
            {(['stella', 'tide'] as const).map((key) => (
              <button
                key={key}
                type="button"
                className={voice === key ? 'seg-item is-on' : 'seg-item'}
                onClick={() => setVoice(key)}
              >
                {key === 'stella' ? 'stella（女声）' : 'tide（男声）'}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <span className="field-label">换肤</span>
          <div className="seg-group">
            {allSkins().map((item) => (
              <button
                key={item.key}
                type="button"
                className={skin === item.key ? 'seg-item is-on' : 'seg-item'}
                onClick={() => {
                  setSkin(item.key)
                  void window.api.setSkin(item.key)
                }}
              >
                {item.label}
              </button>
            ))}
            <button
              type="button"
              className="seg-item"
              onClick={() => {
                void (async () => {
                  const result = await window.api.importSkin()
                  if (!result.ok || !result.key) return
                  await refreshSkins()
                  setSkin(result.key as string)
                })()
              }}
            >
              ＋ 导入图片
            </button>
          </div>
          <span className="field-hint">点一下立刻换，悬浮球和面板一起换，下次启动还记着。</span>
        </div>

        <label className="switch-row">
          <span>
            <span className="field-label">说话时允许插话</span>
            <span className="field-hint">播报中听到你开口就立刻停下听你说。</span>
          </span>
          <input
            type="checkbox"
            checked={bargeIn}
            onChange={(event) => setBargeIn(event.target.checked)}
          />
        </label>

        <label className="field">
          <span className="field-label">语音接口地址</span>
          <input
            className="input"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            spellCheck={false}
          />
        </label>

        <div className="row-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void save()}
            disabled={state.kind === 'busy'}
          >
            {state.kind === 'busy' ? (
              <Loader2 size={15} className="spin" />
            ) : (
              <Check size={15} strokeWidth={2} />
            )}
            保存并校验
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void clearKey()}
            disabled={!settings?.hasKey}
          >
            清除钥匙
          </button>
        </div>

        {state.text && (
          <div className={state.kind === 'bad' ? 'toast bad' : 'toast ok'}>{state.text}</div>
        )}

        <dl className="meta">
          <div>
            <dt>DSH 会话</dt>
            <dd>{sessionId ?? '还没连上'}</dd>
          </div>
          <div>
            <dt>模式</dt>
            <dd>{preset ?? '未知（预设没装好就会用默认模式）'}</dd>
          </div>
          <div>
            <dt>唤醒词</dt>
            <dd>{settings?.wakeWord ?? WAKE_WORD}</dd>
          </div>
          <div>
            <dt>麦克风</dt>
            <dd>{settings?.micEnabled ? '常驻监听中' : '已关闭'}</dd>
          </div>
        </dl>
      </div>
    </>
  )
}
