import React from 'react'
import { createRoot } from 'react-dom/client'
import Orb from './Orb'
import { chime, pushPcm, setPlaybackIdleListener, startMic, stopPlayback } from './audio'
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

// 播放：主进程把 TTS 的裸 PCM 分片推过来；播完通知主进程
setPlaybackIdleListener(() => window.api.notifySpeechEnd())
window.api.onSpeechChunk((buffer) => pushPcm(buffer))

// 唤醒：先响一声，再清掉上一轮还没播完的音频（打断）
window.api.onWake(() => {
  stopPlayback()
  chime('wake')
})

// 只有真正的打断（唤醒 / 插话 / 面板停止）才掐音频；
// 连续对话自动开麦时状态也会变成 listening，那时候不能掐，否则话说到一半就没了。
window.api.onSpeechStop(() => stopPlayback())

