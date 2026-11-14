import React from 'react'
import { createRoot } from 'react-dom/client'
import Orb from './Orb'
import { chime, pushPcm, startMic, stopPlayback } from './audio'
import './orb.css'

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <Orb />
  </React.StrictMode>
)

// 皮肤：启动读一次，之后由主进程推送
const applySkin = (skin: string): void => {
  document.documentElement.dataset.skin = skin || 'auto'
}
void window.api.getSkin().then((skin) => applySkin(skin))
window.api.onSkin((skin) => applySkin(skin))

// 采集：麦克风 → 主进程（唤醒词 + 端点检测都在主进程）
void startMic((chunk) => window.api.feedAudio(chunk))

// 播放：主进程把 TTS 的裸 PCM 分片推过来
window.api.onSpeechChunk((buffer) => pushPcm(buffer))

// 唤醒：先响一声，再清掉上一轮还没播完的音频（打断）
window.api.onWake(() => {
  stopPlayback()
  chime('wake')
})

window.api.onVoiceState(({ state }) => {
  if (state === 'listening' || state === 'thinking') stopPlayback()
})

