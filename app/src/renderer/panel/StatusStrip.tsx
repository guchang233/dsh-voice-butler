import { useEffect, useRef } from 'react'
import { Square } from 'lucide-react'

type Props = {
  text: string
  sessionLabel: string
  busy: boolean
  onStop: () => void
  onNewSession?: () => void
}

/** 头部下面 40px：实时频谱、状态、会话标签、停止 */
export default function StatusStrip({ text, sessionLabel, busy, onStop, onNewSession }: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const bandsRef = useRef<number[]>([0, 0, 0, 0, 0, 0, 0, 0])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const draw = (): void => {
      const width = canvas.width
      const height = canvas.height
      ctx.clearRect(0, 0, width, height)
      const bands = bandsRef.current
      const gap = 3
      const bar = (width - gap * (bands.length - 1)) / bands.length
      const style = getComputedStyle(canvas)
      ctx.fillStyle = style.color || '#6b665d'
      bands.forEach((level, index) => {
        const h = Math.max(2, Math.min(height, level * height))
        const x = index * (bar + gap)
        ctx.beginPath()
        ctx.roundRect(x, (height - h) / 2, bar, h, 2)
        ctx.fill()
      })
    }
    draw()
    return window.api.onAudioBands((bands) => {
      if (!bands || bands.length === 0) return
      bandsRef.current = bands.slice(0, 8)
      while (bandsRef.current.length < 8) bandsRef.current.push(0)
      draw()
    })
  }, [])

  return (
    <div className="status-strip">
      <canvas ref={canvasRef} className="status-wave" width={72} height={24} aria-hidden="true" />
      <span className="status-text">{text}</span>
      <span className="session-tag" title={sessionLabel}>
        {sessionLabel}
      </span>
      {onNewSession && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={onNewSession}>
          新会话
        </button>
      )}
      {busy && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={onStop}>
          <Square size={12} strokeWidth={2} />
          停止
        </button>
      )}
    </div>
  )
}
