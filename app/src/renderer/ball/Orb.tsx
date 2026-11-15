import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { SkinImage } from '../shared/SkinImage'

type Press = { x: number; y: number; dragging: boolean }

export default function Orb(): JSX.Element {
  const [pressed, setPressed] = useState(false)
  const [hover, setHover] = useState(false)
  const [state, setState] = useState<
    'idle' | 'listening' | 'thinking' | 'speaking' | 'confirming' | 'offline' | 'error' | 'muted'
  >('idle')
  const [level, setLevel] = useState(0)
  const pressRef = useRef<Press | null>(null)
  const pressTimer = useRef<number | null>(null)

  useEffect(() => {
    const onMove = (event: PointerEvent): void => {
      const press = pressRef.current
      if (!press || press.dragging) return
      const dx = event.screenX - press.x
      const dy = event.screenY - press.y
      // 8px 容差：手抖一两像素不该被当成拖拽，否则「点一下」会被吃成拖拽
      if (Math.hypot(dx, dy) > 8) {
        press.dragging = true
        window.api.dragStart()
      }
    }

    const onUp = (event: PointerEvent): void => {
      const press = pressRef.current
      pressRef.current = null
      // 右键的那一下弹动交给 flashPress 的定时器，松手别把它立刻掐掉
      if (event.button !== 2) setPressed(false)
      if (!press) return
      if (press.dragging) window.api.dragEnd()
      else void window.api.togglePanel()
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [])

  useEffect(() => {
    const offHover = window.api.onBallHover(setHover)
    const offState = window.api.onVoiceState((payload) => {
      setState(payload.state)
      if (payload.state !== 'listening') setLevel(0)
    })
    const offLevel = window.api.onMicLevel(setLevel)
    return () => {
      offHover()
      offState()
      offLevel()
    }
  }, [])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    pressRef.current = { x: event.screenX, y: event.screenY, dragging: false }
    setPressed(true)
  }

  /** 右键也弹一下：按下就有 Q 弹反馈，松手（或 260ms 后）复原 */
  const flashPress = (): void => {
    setPressed(true)
    if (pressTimer.current !== null) window.clearTimeout(pressTimer.current)
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null
      setPressed(false)
    }, 260)
  }

  const scale = 1 + Math.min(level, 1) * 0.12

  return (
    <div
      className={`stage is-${state}${hover ? ' is-hover' : ''}`}
      // 右键 = 看时段和余额（和原作小鲸鱼一样）。
      // 用 mousedown(button=2) 触发，比 contextmenu 稳：非聚焦的透明窗口不一定派发后者。
      onMouseDown={(event) => {
        if (event.button !== 2) return
        event.preventDefault()
        flashPress()
        window.api.showPeek()
      }}
      onContextMenu={(event) => {
        // 只负责压掉系统菜单，触发走上面的 mousedown
        event.preventDefault()
      }}
    >
      <div className="float">
        <div
          className={pressed ? 'orb is-pressed' : 'orb'}
          onPointerDown={onPointerDown}
          role="button"
          aria-label="管家"
          style={state === 'listening' ? { transform: `scale(${scale})` } : undefined}
        >
          <span className="orb-ring" />
          <SkinImage className="orb-char" />
        </div>
      </div>
    </div>
  )
}


