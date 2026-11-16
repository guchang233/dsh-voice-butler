import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import SettingsView from '../src/renderer/panel/SettingsView'
import type { PublicSettings } from '../src/shared/ipc'

const settings: PublicSettings = {
  skin: 'whale',
  theme: 'system',
  accent: 'none',
  effect: 'soft',
  continuous: false,
  ballLevel: 'float',
  hasKey: true,
  asrProvider: 'dashscope-ws',
  hasAsrKey: true,
  asrModel: 'qwen3-asr-flash-realtime',
  baseUrl: 'https://api.deepseek.com',
  ballPosition: null,
  wakeWord: '大肥鱼',
  micEnabled: true,
  ttsProvider: 'dashscope',
  ttsModel: 'qwen3-tts-flash',
  ttsVoice: 'Cherry',
  bargeIn: true,
  sessionId: 'session-probe',
  sessionTitle: '管家模式',
  dshOrigin: '',
}

function render(): string {
  return renderToStaticMarkup(
    <SettingsView
      settings={settings}
      onToast={() => {}}
      sessionId="session-probe"
      preset="butler"
      origin="http://127.0.0.1:1"
      onSaved={() => {}}
      onRefresh={async () => {}}
    />
  )
}

describe('设置页的标签页', () => {
  it('顶部有六个标签', () => {
    const html = render()
    const tabs = [...html.matchAll(/class="set-tab[^"]*"[^>]*>([^<]+)</g)].map((m) => m[1])
    expect(tabs).toEqual(['语音识别', '语音合成', '对话', '外观', 'DSH', '人格'])
  })

  it('默认只显示语音识别那张卡，其余都藏起来', () => {
    const html = render()
    const cards = [...html.matchAll(/<section class="set-card"([^>]*)>\s*<h2>([^<]+)<\/h2>/g)].map((m) => ({
      hidden: m[1].includes('hidden'),
      title: m[2],
    }))
    expect(cards.map((c) => c.title)).toEqual(['对话', '语音识别', '语音', '外观', 'DSH 连接', '人格'])
    expect(cards.filter((c) => !c.hidden).map((c) => c.title)).toEqual(['语音识别'])
  })

  it('语音识别页有三家厂商、模型下拉、密钥输入', () => {
    const html = render()
    expect(html).toContain('硅基流动')
    expect(html).toContain('百炼（实时）')
    expect(html).toContain('百炼（整段）')
    expect(html).toContain('DeepSeek')
    expect(html).not.toContain('智谱')
    expect(html).toContain('识别模型')
    expect(html).toContain('qwen3-asr-flash-realtime')
    expect(html).toContain('key-row')
  })

  it('语音识别有三个按钮：保存 / 应用 / 校验，且没有「清除识别 Key」', () => {
    const html = render()
    expect(html).toContain('>保存<')
    expect(html).toContain('>应用<')
    expect(html).toContain('>校验<')
    expect(html).not.toContain('保存并校验')
    expect(html).not.toContain('清除识别 Key')
  })

  it('DSH 页里有会话和模型两个下拉', () => {
    const html = render()
    expect(html).toContain('管家会话')
    expect(html).toContain('管家用的模型')
    expect(html).toContain('切到这条会话')
    expect(html).toContain('用这个模型')
  })
})
