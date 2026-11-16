import { useEffect, useState } from 'react'
import { Check, Loader2 } from 'lucide-react'
import {
  ASR_PROVIDERS,
  type AsrProvider,
  BALL_LEVELS,
  WAKE_WORD,
  type Accent,
  type BallLevel,
  type EffectLevel,
  type PublicSettings,
  type ThemeMode,
} from '../../shared/ipc'
import SkinGrid from './SkinGrid'

type Tone = { kind: 'idle' | 'busy' | 'ok' | 'bad'; text: string }

type Props = {
  settings: PublicSettings | null
  notice: string | null
  sessionId: string | null
  preset: string | null
  origin: string
  onSaved: (next: PublicSettings, message: string) => void
  onRefresh: () => Promise<void>
}

type SetTab = 'asr' | 'tts' | 'chat' | 'look' | 'dsh' | 'persona'

const SET_TABS: Array<{ key: SetTab; label: string }> = [
  { key: 'asr', label: '语音识别' },
  { key: 'tts', label: '语音合成' },
  { key: 'chat', label: '对话' },
  { key: 'look', label: '外观' },
  { key: 'dsh', label: 'DSH' },
  { key: 'persona', label: '人格' }
]

export default function SettingsView({
  settings,
  notice,
  sessionId,
  preset,
  origin,
  onSaved,
  onRefresh,
}: Props): JSX.Element {
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(settings?.baseUrl ?? 'https://api.deepseek.com')
  const [dshOrigin, setDshOrigin] = useState(settings?.dshOrigin ?? '')
  const [voice, setVoice] = useState<'stella' | 'tide'>(settings?.ttsVoice ?? 'stella')
  const [skin, setSkin] = useState<string>(settings?.skin ?? 'whale')
  const [bargeIn, setBargeIn] = useState(settings?.bargeIn ?? false)
  const [continuous, setContinuous] = useState(settings?.continuous ?? false)
  const [theme, setTheme] = useState<ThemeMode>(settings?.theme ?? 'system')
  const [accent, setAccent] = useState<Accent>(settings?.accent ?? 'none')
  const [effect, setEffect] = useState<EffectLevel>(settings?.effect ?? 'vivid')
  const [ballLevel, setBallLevel] = useState<BallLevel>(settings?.ballLevel ?? 'top')
  const [tab, setTab] = useState<SetTab>(settings ? 'asr' : 'asr')
  const [asrProvider, setAsrProvider] = useState<AsrProvider>(settings?.asrProvider ?? 'siliconflow')
  const [asrKey, setAsrKey] = useState('')
  const [persona, setPersona] = useState('')
  const [personaIsDefault, setPersonaIsDefault] = useState(true)
  const [personaState, setPersonaState] = useState<Tone>({ kind: 'idle', text: '' })
  const [state, setState] = useState<Tone>({ kind: 'idle', text: '' })

  useEffect(() => {
    void window.api.getPersona().then((result) => {
      setPersona(result.text ?? '')
      setPersonaIsDefault(result.isDefault !== false)
    })
  }, [])

  // settings 是异步来的：到了要把识别厂商对齐，否则界面会停在上面的 fallback 值
  useEffect(() => {
    if (!settings) return
    setAsrProvider(settings.asrProvider)
  }, [settings?.asrProvider])

  const save = async (): Promise<void> => {
    setState({ kind: 'busy', text: '正在校验…' })
    const result = await window.api.saveSettings({
      apiKey: apiKey.trim() || undefined,
      asrProvider,
      asrApiKey: asrKey.trim() || undefined,
      baseUrl: baseUrl.trim() || undefined,
      dshOrigin: dshOrigin.trim(),
      ttsVoice: voice,
      bargeIn,
      continuous,
      theme,
      accent,
    })
    if (!result.ok) {
      setState({ kind: 'bad', text: result.error })
      return
    }
    setState({ kind: 'ok', text: '已保存' })
    const next = await window.api.getSettings()
    onSaved(next, '设置已保存')
  }

  const clearAsrKey = async (): Promise<void> => {
    const result = await window.api.saveSettings({ asrProvider, asrApiKey: '' })
    if (result.ok) {
      const next = await window.api.getSettings()
      onSaved(next, '识别 Key 已清除')
    }
  }

  const clearKey = async (): Promise<void> => {
    const result = await window.api.saveSettings({ apiKey: '' })
    if (result.ok) {
      const next = await window.api.getSettings()
      onSaved(next, '语音钥匙已清除')
    }
  }

  const savePersona = async (): Promise<void> => {
    setPersonaState({ kind: 'busy', text: '保存中…' })
    const result = await window.api.savePersona(persona)
    if (!result.ok) {
      setPersonaState({ kind: 'bad', text: result.error })
      return
    }
    setPersona(result.text)
    setPersonaIsDefault(result.isDefault)
    setPersonaState({ kind: 'ok', text: '已保存，下一句就生效' })
  }

  const resetPersona = async (): Promise<void> => {
    const result = await window.api.resetPersona()
    if (!result.ok) {
      setPersonaState({ kind: 'bad', text: result.error })
      return
    }
    setPersona(result.text)
    setPersonaIsDefault(true)
    setPersonaState({ kind: 'ok', text: '已恢复内置人格' })
  }

  return (
    <div className="settings">
      {notice && <div className="toast ok">{notice}</div>}

      <section className="set-card" hidden={tab !== 'chat'}>
        <h2>对话</h2>
        <label className="switch-row">
          <span>
            <span className="field-label">连续对话</span>
            <span className="field-hint">
              一轮说完直接接着听，不用再喊「{WAKE_WORD}」；说「没事了」结束，静默 15 秒也会退回。
            </span>
          </span>
          <input
            type="checkbox"
            checked={continuous}
            onChange={(event) => {
              const next = event.target.checked
              setContinuous(next)
              void window.api.saveSettings({ continuous: next }).then(() => onRefresh())
            }}
          />
        </label>
        <label className="switch-row">
          <span>
            <span className="field-label">说话时允许用唤醒词打断</span>
            <span className="field-hint">
              播报中喊「大肥鱼」立刻住嘴转去听你说；不喊就不打断（不会因为声音变大自己停）。
            </span>
          </span>
          <input type="checkbox" checked={bargeIn} onChange={(event) => setBargeIn(event.target.checked)} />
        </label>
      </section>

      <section className="set-card" hidden={tab !== 'asr'}>
        <h2>语音识别</h2>
        <div className="field">
          <span className="field-label">用哪家识别</span>
          <div className="seg-group">
            {ASR_PROVIDERS.map((item) => (
              <button
                key={item.value}
                type="button"
                className={asrProvider === item.value ? 'seg-item is-on' : 'seg-item'}
                onClick={() => setAsrProvider(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <span className="field-hint">
            {ASR_PROVIDERS.find((item) => item.value === asrProvider)?.hint ?? ''}。
            {asrProvider === 'deepseek' ? '' : 'Key 在对应厂商控制台免费创建。'}
            说话过程中先给你看实时字幕，说完再整段重识别一次。
          </span>
        </div>

        {asrProvider !== 'deepseek' && (
          <label className="field">
            <span className="field-label">
              {ASR_PROVIDERS.find((item) => item.value === asrProvider)?.label ?? ''} 识别 Key
            </span>
            <input
              className="input"
              type="password"
              placeholder={settings?.hasAsrKey ? '已配置，留空表示不修改' : 'sk-…'}
              value={asrKey}
              onChange={(event) => setAsrKey(event.target.value)}
              spellCheck={false}
            />
            <span className="field-hint">改完点下面的「保存并校验」，会先查一次模型列表，不花识别额度。</span>
          </label>
        )}

        <div className="row-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void save()}
            disabled={state.kind === 'busy'}
          >
            {state.kind === 'busy' ? <Loader2 size={15} className="spin" /> : <Check size={15} strokeWidth={2} />}
            保存并校验
          </button>
          {asrProvider !== 'deepseek' && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void clearAsrKey()}
              disabled={!settings?.hasAsrKey}
            >
              清除识别 Key
            </button>
          )}
        </div>
        {state.text && <div className={state.kind === 'bad' ? 'toast bad' : 'toast ok'}>{state.text}</div>}
      </section>

      <section className="set-card" hidden={tab !== 'tts'}>
        <h2>语音</h2>
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
            对话在 DSH 里跑。这把 Key 只驱动识别和合成，保存时用 <code>GET /models</code> 校验。
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
            {state.kind === 'busy' ? <Loader2 size={15} className="spin" /> : <Check size={15} strokeWidth={2} />}
            保存并校验
          </button>

          <button type="button" className="btn btn-ghost" onClick={() => void clearKey()} disabled={!settings?.hasKey}>
            清除钥匙
          </button>
        </div>
        {state.text && <div className={state.kind === 'bad' ? 'toast bad' : 'toast ok'}>{state.text}</div>}
      </section>

      <section className="set-card" hidden={tab !== 'look'}>
        <h2>外观</h2>
        <div className="field">
          <span className="field-label">界面主题</span>
          <div className="seg-group">
            {(
              [
                ['system', '跟随系统'],
                ['light', '纸（亮）'],
                ['dark', '墨（暗）'],
              ] as Array<[ThemeMode, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={theme === key ? 'seg-item is-on' : 'seg-item'}
                onClick={() => {
                  setTheme(key)
                  void window.api.saveSettings({ theme: key }).then(() => onRefresh())
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span className="field-label">强调色</span>
          <div className="seg-group">
            {(
              [
                ['none', '默认'],
                ['rose', '玫瑰'],
                ['ocean', '海'],
              ] as Array<[Accent, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={accent === key ? 'seg-item is-on' : 'seg-item'}
                onClick={() => {
                  setAccent(key)
                  void window.api.saveSettings({ accent: key }).then(() => onRefresh())
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="field-hint">玫瑰和海是两套配色，跟贴图分开，不再互相盖住。</span>
        </div>
        <div className="field">
          <span className="field-label">特效强度</span>
          <div className="seg-group">
            {(
              [
                ['off', '关'],
                ['soft', '柔和'],
                ['vivid', '炫酷'],
              ] as Array<[EffectLevel, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={effect === key ? 'seg-item is-on' : 'seg-item'}
                onClick={() => {
                  setEffect(key)
                  void window.api.saveSettings({ effect: key }).then(() => onRefresh())
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="field-hint">默认是半分辨率的流光边框。关就完全不画；系统开了减弱动效时会换成细光条。</span>
        </div>
        <div className="field">
          <span className="field-label">悬浮球层级</span>
          <div className="seg-group">
            {BALL_LEVELS.map((item) => (
              <button
                key={item.value}
                type="button"
                className={ballLevel === item.value ? 'seg-item is-on' : 'seg-item'}
                onClick={() => {
                  setBallLevel(item.value)
                  void window.api.saveSettings({ ballLevel: item.value }).then(() => onRefresh())
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
          <span className="field-hint">{BALL_LEVELS.find((item) => item.value === ballLevel)?.hint}</span>
        </div>
        <div className="field">
          <span className="field-label">换肤</span>
          <SkinGrid
            current={skin}
            onPick={async (key) => {
              const applied = await window.api.setSkin(key)
              setSkin(applied)
              await onRefresh()
            }}
            onRefresh={onRefresh}
          />
        </div>
      </section>

      <section className="set-card" hidden={tab !== 'dsh'}>
        <h2>DSH 连接</h2>
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
            留空就自动读 <code>endpoint.json</code>。请求要带里面的令牌。
          </span>
        </label>
        <dl className="meta">
          <div>
            <dt>DSH 会话</dt>
            <dd>{sessionId ?? '还没连上'}</dd>
          </div>
          <div>
            <dt>模式</dt>
            <dd>{preset ?? '未知'}</dd>
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
      </section>

      <section className="set-card" hidden={tab !== 'persona'}>
        <h2>人格</h2>
        <textarea
          className="persona-box"
          value={persona}
          onChange={(event) => setPersona(event.target.value)}
          spellCheck={false}
          rows={10}
        />
        <span className="field-hint">
          {personaIsDefault ? '现在是内置人格。' : '现在是你自己写的人格。'}
          改完下一句就生效。
        </span>
        <div className="row-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => void savePersona()}
            disabled={personaState.kind === 'busy'}
          >
            保存人格
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void resetPersona()}>
            恢复默认
          </button>
          <span className="persona-count">{persona.length} 字</span>
        </div>
        {personaState.text && (
          <div className={personaState.kind === 'bad' ? 'toast bad' : 'toast ok'}>{personaState.text}</div>
        )}
      </section>
    </div>
  )
}
