import { useEffect, useRef, useState } from 'react'

type Mode = 'off' | 'voice' | 'action'
type State = { mode: Mode; phase: string; tools: number }

const PALETTE: Record<'voice' | 'action', { a: string; b: string; c: string; glow: string }> = {
  voice: { a: '#6fe3ff', b: '#7ea8ff', c: '#b18cff', glow: 'rgba(126, 168, 255, 0.55)' },
  action: { a: '#ffd479', b: '#ff9a4d', c: '#ff5d73', glow: 'rgba(255, 140, 90, 0.55)' }
}

const PHASE_SPEED: Record<string, number> = {
  listening: 0.55,
  thinking: 1.35,
  speaking: 1.0,
  confirming: 0.8,
  action: 1.6
}

export default function Overlay(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [state, setState] = useState<State>({ mode: 'off', phase: 'idle', tools: 0 })
  const targetRef = useRef<Mode>('off')
  const phaseRef = useRef<string>('idle')
  const alphaRef = useRef(0)
  const mixRef = useRef(0) // 0 = voice, 1 = action

  useEffect(() => {
    const off = window.api.onOverlay((payload: State) => {
      setState(payload)
      targetRef.current = payload.mode
      phaseRef.current = payload.mode === 'action' ? 'action' : payload.phase
    })
    return off
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0
    let width = 0
    let height = 0
    const dpr = Math.min(window.devicePixelRatio || 1, 2)

    const resize = (): void => {
      width = window.innerWidth
      height = window.innerHeight
      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    window.addEventListener('resize', resize)

    const start = performance.now()

    const draw = (now: number): void => {
      raf = requestAnimationFrame(draw)
      const t = (now - start) / 1000

      const wantAlpha = targetRef.current === 'off' ? 0 : 1
      alphaRef.current += (wantAlpha - alphaRef.current) * 0.08
      const wantMix = targetRef.current === 'action' ? 1 : 0
      mixRef.current += (wantMix - mixRef.current) * 0.06

      ctx.clearRect(0, 0, width, height)
      const alpha = alphaRef.current
      if (alpha < 0.01) return

      const pal = {
        a: mixRef.current > 0.5 ? PALETTE.action.a : PALETTE.voice.a,
        b: mixRef.current > 0.5 ? PALETTE.action.b : PALETTE.voice.b,
        c: mixRef.current > 0.5 ? PALETTE.action.c : PALETTE.voice.c,
        glow: mixRef.current > 0.5 ? PALETTE.action.glow : PALETTE.voice.glow
      }
      const speed = PHASE_SPEED[phaseRef.current] ?? 0.8
      // 压扁：只留顶部一条窄带（约 72–96px），不再占掉屏幕上沿一大块
      const bandHeight = Math.max(72, Math.min(96, height * 0.085))

      ctx.save()
      ctx.globalAlpha = alpha

      // 顶部整体氛围光
      const halo = ctx.createLinearGradient(0, 0, 0, bandHeight * 1.15)
      halo.addColorStop(0, pal.glow)
      halo.addColorStop(0.45, 'rgba(0,0,0,0)')
      ctx.globalAlpha = alpha * 0.18
      ctx.fillStyle = halo
      ctx.fillRect(0, 0, width, bandHeight * 1.15)
      ctx.globalAlpha = alpha

      // 流动缎带
      const ribbons = 4
      for (let i = 0; i < ribbons; i++) {
        const baseY = bandHeight * (0.22 + i * 0.2)
        const amp = 5 + i * 3.2
        const freq = 0.0028 + i * 0.0008
        const phase = t * speed * (0.6 + i * 0.18) + i * 1.7
        const grad = ctx.createLinearGradient(0, 0, width, 0)
        const color = i % 3 === 0 ? pal.c : i % 3 === 1 ? pal.a : pal.b
        grad.addColorStop(0, 'rgba(0,0,0,0)')
        grad.addColorStop(0.18, hexToRgba(color, 0.05))
        grad.addColorStop(0.5, hexToRgba(color, 0.65 - i * 0.1))
        grad.addColorStop(0.82, hexToRgba(color, 0.05))
        grad.addColorStop(1, 'rgba(0,0,0,0)')

        ctx.beginPath()
        for (let x = 0; x <= width; x += 8) {
          const y =
            baseY +
            Math.sin(x * freq + phase) * amp +
            Math.sin(x * freq * 2.3 + phase * 1.7) * (amp * 0.35)
          if (x === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.strokeStyle = grad
        ctx.lineWidth = 2 + i * 0.8
        ctx.shadowBlur = 11
        ctx.shadowColor = hexToRgba(color, 0.5)
        ctx.stroke()
      }
      ctx.shadowBlur = 0

      // 顶部一道细亮线，像被点亮的天际
      const edge = ctx.createLinearGradient(0, 0, width, 0)
      edge.addColorStop(0, 'rgba(0,0,0,0)')
      edge.addColorStop(0.3, hexToRgba(pal.a, 0.55))
      edge.addColorStop(0.5, hexToRgba(pal.b, 0.85))
      edge.addColorStop(0.7, hexToRgba(pal.c, 0.55))
      edge.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = edge
      ctx.fillRect(0, 0, width, 1.6)

      // 缓慢横扫的光斑
      const sweepX = ((t * speed * 0.12) % 1.6 - 0.3) * width
      const sweep = ctx.createRadialGradient(sweepX, 0, 0, sweepX, 0, width * 0.35)
      sweep.addColorStop(0, hexToRgba(pal.b, 0.16))
      sweep.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = sweep
      ctx.fillRect(0, 0, width, bandHeight)

      ctx.restore()
    }

    raf = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      data-mode={state.mode}
      aria-hidden="true"
      style={{ pointerEvents: 'none' }}
    />
  )
}

function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace('#', '')
  const r = parseInt(value.slice(0, 2), 16)
  const g = parseInt(value.slice(2, 4), 16)
  const b = parseInt(value.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

