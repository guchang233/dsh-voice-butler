import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Mic, MicOff, X } from 'lucide-react'
import { WAKE_WORD, type LinkState, type PublicSettings, type VoiceFrame, type VoiceState } from '../../shared/ipc'
import { useSkinTick } from '../shared/SkinImage'
import { SkinImage } from '../shared/SkinImage'
import ChatView from './ChatView'
import SettingsView from './SettingsView'
import type { AsrPartial } from '../../shared/ipc'
import StatusStrip from './StatusStrip'
import { applyFrame, nextId, type Item } from './thread'

type View = 'chat' | 'settings'

/**
 * 面板只做一件事：把 DSH 管家会话里发生的事显示出来，并把你说的话送进去。
 */
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

  const inputRef = useRef<HTMLInputElement>(null)
  const streamId = useRef<string | null>(null)

  useSkinTick()

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

  useEffect(() => {
    const offFrame = window.api.onFrame((frame: VoiceFrame) => {
      setItems((prev) => applyFrame(prev, frame, streamId))
      if (frame.t === 'state') setPhase(frame.phase)
      if (frame.t === 'hello') {
        if (frame.sessionId) setSessionId(frame.sessionId)
        if (frame.preset) setPreset(frame.preset)
      }
      if (frame.t === 'approval') setApproval({ id: frame.id, tool: frame.tool, reason: frame.reason })
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
    const offSettings = window.api.onSettings((next) => {
      setSettings(next)
      setMicOn(next.micEnabled)
    })
    return () => {
      offFrame()
      offHistory()
      offReset()
      offLink()
      offVoice()
      offShown()
      offSettings()
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (document.querySelector('.skin-menu, .skin-rename')) return
      void window.api.hidePanel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const refreshSettings = useCallback(async () => {
    const next = await window.api.getSettings()
    setSettings(next)
    setMicOn(next.micEnabled)
  }, [])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text) return
    setInput('')
    const result = await window.api.say(text)
    if (!result.ok) {
      setItems((prev) => [...prev, { kind: 'notice', id: nextId(), tone: 'error', text: result.error }])
    }
  }, [input])

  // 边说边出的字幕：在听的时候把识别到的字铺出来，心里有数
  const [caption, setCaption] = useState<AsrPartial>({ committed: '', partial: '' })
  useEffect(() => window.api.onAsrPartial((payload) => setCaption(payload)), [])
  useEffect(() => {
    if (voiceState !== 'listening' && voiceState !== 'confirming') {
      setCaption({ committed: '', partial: '' })
    }
  }, [voiceState])

  const statusText = useMemo(() => {
    if (link === 'offline') return 'DSH 没连上'
    if (link === 'connecting') return '正在连 DSH…'
    if (voiceState === 'listening' || voiceState === 'confirming') {
      const heard = `${caption.committed}${caption.partial}`.trim()
      if (heard) return heard
      if (voiceState === 'confirming') return '等你点头…'
      return '在听你说…'
    }
    if (voiceState === 'speaking') return '正在说'
    if (phase === 'tool') return '在动这台电脑'
    if (voiceState === 'thinking' || phase === 'thinking') return '在想'
    if (!settings?.hasKey) return '还没配语音钥匙'
    return `说「${settings?.wakeWord ?? WAKE_WORD}」或按住话筒`
  }, [link, voiceState, phase, settings, caption])

  const busy = phase !== 'idle' || voiceState === 'thinking' || voiceState === 'speaking'
  const sessionLabel = preset ? `管家模式 · ${sessionId?.slice(-6) ?? '—'}` : (sessionId?.slice(-6) ?? '未连接')

  return (
    <div className="shell">
      <div className="card">
        <header className="site-header">
          <SkinImage className="avatar" />
          <div className="who">
            <span className="name">
              管家
              <span className={link === 'online' ? 'link-dot on' : 'link-dot'} title={origin} />
              {settings?.continuous && (
                <span className="live-badge" title="连续对话：说完直接接着听">
                  连续
                </span>
              )}
            </span>
            <span className="sub">{settings?.wakeWord ?? WAKE_WORD}</span>
          </div>
          <div className="header-seg" role="tablist" aria-label="对话或设置">
            <button
              type="button"
              role="tab"
              aria-selected={view === 'chat'}
              className={view === 'chat' ? 'is-on' : ''}
              onClick={() => setView('chat')}
            >
              对话
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'settings'}
              className={view === 'settings' ? 'is-on' : ''}
              onClick={() => setView('settings')}
            >
              设置
            </button>
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
          <button className="icon-btn" title="收起" aria-label="收起" onClick={() => window.api.hidePanel()}>
            <X size={17} strokeWidth={1.7} />
          </button>
        </header>

        <StatusStrip
          text={statusText}
          sessionLabel={sessionLabel}
          busy={busy}
          onStop={() => void window.api.stop()}
          onNewSession={
            view === 'chat'
              ? () => {
                  streamId.current = null
                  setItems([])
                  void window.api.newSession()
                }
              : undefined
          }
        />

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
            onRefresh={refreshSettings}
          />
        ) : (
          <ChatView
            items={items}
            approval={approval}
            link={link}
            settings={settings}
            input={input}
            setInput={setInput}
            onSend={() => void send()}
            onApprove={(allow) => {
              if (!approval) return
              const id = approval.id
              setApproval(null)
              void window.api.approve(id, allow)
            }}
            inputRef={inputRef}
          />
        )}
      </div>
    </div>
  )
}
