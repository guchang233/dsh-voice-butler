import { useEffect, useRef, useState } from 'react'
import type { EffectLevel, OverlayMode } from '../../shared/ipc'
import './aurora.css'

type Mode = OverlayMode

const CSS_COLOR: Record<Exclude<Mode, 'off'>, string> = {
  wake: 'rgb(58, 245, 166)',
  think: 'rgb(96, 172, 255)',
  act: 'rgb(255, 180, 84)',
  mouse: 'rgb(255, 138, 24)',
}

function prefersStill(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function hasWebGL2(): boolean {
  try {
    const probe = document.createElement('canvas')
    return Boolean(probe.getContext('webgl2'))
  } catch {
    return false
  }
}

export default function Overlay(): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const workerRef = useRef<Worker | null>(null)
  const [mode, setMode] = useState<Mode>('off')
  const [fx, setFx] = useState<EffectLevel>('vivid')
  const [since, setSince] = useState(0)
  const [css, setCss] = useState(() => prefersStill() || !hasWebGL2())

  useEffect(() => {
    const off = window.api.onOverlay((payload) => {
      const next = payload?.mode ?? 'off'
      const nextFx = payload?.fx ?? 'vivid'
      setFx(nextFx)
      setMode(nextFx === 'off' ? 'off' : next)
      if (next !== 'off') setSince(payload?.since ?? Date.now())
      workerRef.current?.postMessage({ type: 'state', mode: next, fx: nextFx })
    })
    const offAudio = window.api.onAudioBands((bands) => {
      if (!bands || bands.length === 0) return
      workerRef.current?.postMessage({ type: 'bands', bands })
    })
    const offSettings = window.api.onSettings((settings) => {
      setFx(settings.effect)
      if (settings.effect === 'off') setMode('off')
    })
    return () => {
      off()
      offAudio()
      offSettings()
    }
  }, [])

  useEffect(() => {
    if (css || fx === 'off') return
    const host = hostRef.current
    if (!host) return
    // 开发模式的 StrictMode 会把 effect 拆掉再装上。画布只能移交一次，所以每次都新建一张。
    const canvas = document.createElement('canvas')
    canvas.setAttribute('aria-hidden', 'true')
    canvas.style.cssText = 'pointer-events:none;display:block;width:100%;height:100%'
    host.replaceChildren(canvas)
    let worker: Worker
    try {
      worker = new Worker(new URL('./aurora.worker.ts', import.meta.url), { type: 'module' })
    } catch {
      setCss(true)
      return
    }
    workerRef.current = worker
    worker.onmessage = (event: MessageEvent<{ type?: string }>) => {
      if (event.data?.type === 'nogpu') setCss(true)
    }
    const resize = (): void => {
      worker.postMessage({ type: 'resize', width: window.innerWidth, height: window.innerHeight })
    }
    try {
      const offscreen = canvas.transferControlToOffscreen()
      worker.postMessage({ type: 'init', canvas: offscreen, width: window.innerWidth, height: window.innerHeight }, [
        offscreen,
      ])
    } catch {
      setCss(true)
      worker.terminate()
      if (workerRef.current === worker) workerRef.current = null
      return
    }
    worker.postMessage({ type: 'state', mode, fx })
    window.addEventListener('resize', resize)
    return () => {
      window.removeEventListener('resize', resize)
      worker.terminate()
      if (workerRef.current === worker) workerRef.current = null
      canvas.remove()
    }
  }, [css, fx])

  if (fx === 'off' || (mode === 'off' && css)) {
    return <div className="css-aurora is-off" />
  }

  if (css) {
    const color = mode === 'off' ? CSS_COLOR.wake : CSS_COLOR[mode]
    return (
      <div className={mode === 'off' ? 'css-aurora is-off' : 'css-aurora'} style={{ ['--fx' as string]: color }}>
        <i className="edge top" />
        <i className="edge right" />
        <i className="edge bottom" />
        <i className="edge left" />
        <i key={since} className="ripple" />
      </div>
    )
  }

  return <div ref={hostRef} style={{ position: 'fixed', inset: 0, pointerEvents: 'none' }} />
}
