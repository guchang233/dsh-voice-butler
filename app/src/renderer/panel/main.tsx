import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './panel.css'

// 皮肤：启动读一次，之后由主进程推送
const applySkin = (skin: string): void => {
  document.documentElement.dataset.skin = skin || 'auto'
}
void window.api.getSkin().then((skin) => applySkin(skin))
window.api.onSkin((skin) => applySkin(skin))

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
