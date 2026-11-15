import { useEffect, useRef } from 'react'

/**
 * 顶层特效。整层是**穿透**的全屏画布，只负责画，不接任何鼠标。
 *
 * 四套配色，靠模式切换，颜色会做平滑过渡而不是硬跳：
 *   绿 wake  —— 被叫醒，正在听你说
 *   蓝 think —— 在想 / 在说
 *   橙 act   —— 正在操作这台电脑（跑命令、改文件……）
 *   橙 mouse —— 已经在动鼠标、敲键盘操作界面了（这一档四边全亮）
 *
 * 每一帧叠的东西（从底到顶）：
 *   1. 全屏氛围染色（边缘浓、中间淡）
 *   2. 四条边的光晕
 *   3. 内嵌边框 + 行军虚线
 *   4. 四角括号
 *   5. 沿边扫动的光带（mouse 档四条边都有）
 *   6. 从边缘飘进来的粒子
 *   7. 切换瞬间的冲击波 + 全屏闪
 *   8. 缓慢下移的扫描线
 */

type Mode = 'off' | 'wake' | 'think' | 'act' | 'mouse'

type Payload = {
  mode: Mode
  phase: string
  tools: number
  mouse: number
  since: number
}

type Look = {
  core: [number, number, number]
  /** 0..1 整体强度 */
  power: number
  /** 边缘光晕厚度（px） */
  edge: number
  /** 虚线间隔 */
  dash: number
  /** 扫光速度 */
  sweep: number
  /** 粒子数量 */
  particles: number
  /** 是否四条边都有扫光 */
  fourBars: boolean
}

const LOOKS: Record<Exclude<Mode, 'off'>, Look> = {
  wake: {
    core: [58, 245, 166],
    power: 0.72,
    edge: 108,
    dash: 22,
    sweep: 0.34,
    particles: 40,
    fourBars: false
  },
  think: {
    core: [96, 172, 255],
    power: 0.82,
    edge: 122,
    dash: 26,
    sweep: 0.54,
    particles: 34,
    fourBars: false
  },
  act: {
    core: [255, 180, 84],
    power: 0.94,
    edge: 146,
    dash: 30,
    sweep: 0.8,
    particles: 46,
    fourBars: true
  },
  mouse: {
    core: [255, 138, 24],
    power: 1,
    edge: 186,
    dash: 34,
    sweep: 1.15,
    particles: 58,
    fourBars: true
  }
}

function rgba(c: [number, number, number], a: number): string {
  return `rgba(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0}, ${a})`
}

export default function Overlay(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const modeRef = useRef<Mode>('off')
  const sinceRef = useRef(0)
  const kickRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const off = window.api.onOverlay((payload: Payload) => {
      const next = payload?.mode ?? 'off'
      if (next !== modeRef.current) {
        modeRef.current = next
        sinceRef.current = payload?.since ?? Date.now()
      }
      kickRef.current?.()
    })
    return off
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
    let width = 0
    let height = 0
    let raf = 0

    const resize = (): void => {
      width = window.innerWidth
      height = window.innerHeight
      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    window.addEventListener('resize', resize)

    // 粒子：固定种子，位置稳定不抖
    const particles = (() => {
      let seed = 20261115
      const rnd = (): number => {
        seed = (seed * 1664525 + 1013904223) % 4294967296
        return seed / 4294967296
      }
      return Array.from({ length: 64 }, () => ({
        edge: Math.floor(rnd() * 4),
        pos: rnd(),
        depth: 0.1 + rnd() * 0.9,
        speed: 0.07 + rnd() * 0.2,
        size: 0.9 + rnd() * 2.2,
        phase: rnd() * 6.28
      }))
    })()

    const start = performance.now()
    let alpha = 0
    let power = 0
    let looping = false
    const color: [number, number, number] = [58, 245, 166]

    const draw = (now: number): void => {
      const T = (now - start) / 1000
      const mode = modeRef.current
      const look = mode === 'off' ? null : LOOKS[mode]

      alpha += ((look ? 1 : 0) - alpha) * (look ? 0.15 : 0.06)
      if (!look && alpha < 0.004) {
        ctx.clearRect(0, 0, width, height)
        looping = false
        raf = 0
        return
      }

      // 颜色 / 强度平滑过渡
      const target = look ? look.core : color
      for (let i = 0; i < 3; i++) color[i] += (target[i] - color[i]) * 0.15
      power += ((look ? look.power : 0) - power) * 0.1

      const edge = look?.edge ?? 108
      const dash = look?.dash ?? 24
      const sweep = look?.sweep ?? 0.4
      const particleCount = look ? Math.round(look.particles * power) : 0
      const fourBars = look?.fourBars ?? false
      const tLocal = sinceRef.current ? (Date.now() - sinceRef.current) / 1000 : 99
      const breathe = 0.82 + Math.sin(T * 2.1) * 0.18
      const pulse = 0.85 + Math.sin(T * 3.6) * 0.15

      ctx.clearRect(0, 0, width, height)
      ctx.save()
      ctx.globalAlpha = alpha
      ctx.globalCompositeOperation = 'lighter'

      /* 1. 全屏氛围染色 */
      const tint = ctx.createRadialGradient(
        width / 2,
        height / 2,
        Math.min(width, height) * 0.16,
        width / 2,
        height / 2,
        Math.max(width, height) * 0.8
      )
      tint.addColorStop(0, rgba(color, 0))
      tint.addColorStop(0.55, rgba(color, 0.035 * power))
      tint.addColorStop(1, rgba(color, 0.15 * power * breathe))
      ctx.fillStyle = tint
      ctx.fillRect(0, 0, width, height)

      /* 2. 四条边的光晕 */
      const edgeH = Math.min(edge, height * 0.45)
      const edgeW = Math.min(edge * 0.85, width * 0.3)
      const halo = 0.62 * power * breathe

      const top = ctx.createLinearGradient(0, 0, 0, edgeH)
      top.addColorStop(0, rgba(color, halo))
      top.addColorStop(0.4, rgba(color, halo * 0.2))
      top.addColorStop(1, rgba(color, 0))
      ctx.fillStyle = top
      ctx.fillRect(0, 0, width, edgeH)

      const bottom = ctx.createLinearGradient(0, height, 0, height - edgeH)
      bottom.addColorStop(0, rgba(color, halo))
      bottom.addColorStop(0.4, rgba(color, halo * 0.2))
      bottom.addColorStop(1, rgba(color, 0))
      ctx.fillStyle = bottom
      ctx.fillRect(0, height - edgeH, width, edgeH)

      const left = ctx.createLinearGradient(0, 0, edgeW, 0)
      left.addColorStop(0, rgba(color, halo * 0.85))
      left.addColorStop(0.5, rgba(color, halo * 0.16))
      left.addColorStop(1, rgba(color, 0))
      ctx.fillStyle = left
      ctx.fillRect(0, 0, edgeW, height)

      const right = ctx.createLinearGradient(width, 0, width - edgeW, 0)
      right.addColorStop(0, rgba(color, halo * 0.85))
      right.addColorStop(0.5, rgba(color, halo * 0.16))
      right.addColorStop(1, rgba(color, 0))
      ctx.fillStyle = right
      ctx.fillRect(width - edgeW, 0, edgeW, height)

      /* 3. 内嵌边框 + 行军虚线 */
      const inset = 9
      ctx.lineWidth = 1.1 + power * 1.3
      ctx.strokeStyle = rgba(color, 0.42 * power * breathe)
      ctx.strokeRect(inset, inset, width - inset * 2, height - inset * 2)

      ctx.setLineDash([dash, dash * 0.72])
      ctx.lineDashOffset = -T * (24 + sweep * 70)
      ctx.lineWidth = 1.5 + power * 1.7
      ctx.strokeStyle = rgba(color, 0.72 * power * pulse)
      const dashInset = inset + 6
      ctx.strokeRect(dashInset, dashInset, width - dashInset * 2, height - dashInset * 2)
      ctx.setLineDash([])

      /* 3.5 霓虹边框：贴着屏幕四边的实心亮线，带呼吸 */
      const rimW = 2 + power * 2.8
      const rimAlpha = (0.55 + Math.sin(T * 2.7) * 0.2) * power
      ctx.fillStyle = rgba(color, rimAlpha)
      ctx.fillRect(0, 0, width, rimW)
      ctx.fillRect(0, height - rimW, width, rimW)
      ctx.fillRect(0, 0, rimW, height)
      ctx.fillRect(width - rimW, 0, rimW, height)
      // 边框内侧再压一层更亮的细线，看起来像通了电
      ctx.fillStyle = rgba([255, 255, 255].map((v, i) => v * 0.35 + color[i] * 0.65) as [number, number, number], rimAlpha * 0.55)
      ctx.fillRect(0, rimW, width, 1)
      ctx.fillRect(0, height - rimW - 1, width, 1)
      ctx.fillRect(rimW, 0, 1, height)
      ctx.fillRect(width - rimW - 1, 0, 1, height)

      /* 4. 四角括号（双层） */
      const bracket = 64 + power * 92
      const pad = 1.5
      const corners: Array<[number, number, number, number]> = [
        [pad, pad, 1, 1],
        [width - pad, pad, -1, 1],
        [pad, height - pad, 1, -1],
        [width - pad, height - pad, -1, -1]
      ]
      for (const [cx, cy, sx, sy] of corners) {
        // 外层粗括号
        ctx.lineWidth = 3 + power * 4
        ctx.strokeStyle = rgba(color, 0.95 * power * pulse)
        ctx.beginPath()
        ctx.moveTo(cx + sx * bracket, cy)
        ctx.lineTo(cx, cy)
        ctx.lineTo(cx, cy + sy * bracket)
        ctx.stroke()

        // 内层细括号，错开 16px，像取景框
        ctx.lineWidth = 1.2 + power * 1.2
        ctx.strokeStyle = rgba(color, 0.5 * power)
        const inner = 16
        ctx.beginPath()
        ctx.moveTo(cx + sx * (bracket * 0.78), cy + sy * inner)
        ctx.lineTo(cx + sx * inner, cy + sy * inner)
        ctx.lineTo(cx + sx * inner, cy + sy * (bracket * 0.78))
        ctx.stroke()
      }

      /* 4.5 鼠标档：四角向外扩的靶环 */
      if (mode === 'mouse' || mode === 'act') {
        const speedK = mode === 'mouse' ? 0.42 : 0.26
        for (let i = 0; i < corners.length; i++) {
          const [cx, cy, sx, sy] = corners[i]
          const k = ((T * speedK + i * 0.25) % 1 + 1) % 1
          const radius = 26 + k * 230
          ctx.beginPath()
          ctx.arc(cx + sx * 30, cy + sy * 30, radius, 0, Math.PI * 2)
          ctx.lineWidth = 2 + (1 - k) * 3
          ctx.strokeStyle = rgba(color, (1 - k) * 0.5 * power)
          ctx.stroke()
        }
      }

      /* 5. 沿边扫动的光带 */
      const bars = fourBars ? 4 : 2
      for (let i = 0; i < bars; i++) {
        const phase = ((T * sweep + i * 0.41) % 1.6) - 0.3
        if (i % 2 === 0) {
          const x = phase * width
          const y = i === 0 ? 0 : height - 3
          const grad = ctx.createLinearGradient(x - width * 0.15, 0, x + width * 0.15, 0)
          grad.addColorStop(0, rgba(color, 0))
          grad.addColorStop(0.5, rgba(color, 0.55 * power))
          grad.addColorStop(1, rgba(color, 0))
          ctx.fillStyle = grad
          ctx.fillRect(x - width * 0.15, y, width * 0.3, 2.4 + power * 2.4)
        } else {
          const y = phase * height
          const x = i === 1 ? 0 : width - 3
          const grad = ctx.createLinearGradient(0, y - height * 0.15, 0, y + height * 0.15)
          grad.addColorStop(0, rgba(color, 0))
          grad.addColorStop(0.5, rgba(color, 0.5 * power))
          grad.addColorStop(1, rgba(color, 0))
          ctx.fillStyle = grad
          ctx.fillRect(x, y - height * 0.15, 2.4 + power * 2.4, height * 0.3)
        }
      }

      /* 6. 粒子：贴着边缘往里飘 */
      for (let i = 0; i < particleCount; i++) {
        const p = particles[i]
        const drift = (p.pos + T * p.speed) % 1
        const inward = (p.depth * edge) / 2 + Math.sin(T * 1.6 + p.phase) * 7
        let px: number
        let py: number
        if (p.edge === 0) {
          px = drift * width
          py = inward
        } else if (p.edge === 1) {
          px = drift * width
          py = height - inward
        } else if (p.edge === 2) {
          px = inward
          py = drift * height
        } else {
          px = width - inward
          py = drift * height
        }
        const twinkle = 0.3 + Math.abs(Math.sin(T * 1.4 + p.phase)) * 0.7
        ctx.fillStyle = rgba(color, 0.55 * twinkle * power)
        ctx.beginPath()
        ctx.arc(px, py, p.size * (0.8 + power * 0.7), 0, Math.PI * 2)
        ctx.fill()
      }

      /* 7. 开场冲击波 */
      if (tLocal < 1.1) {
        const k = Math.min(1, tLocal / 1.1)
        const ease = 1 - Math.pow(1 - k, 3)
        const rings = mode === 'mouse' ? 3 : 2
        for (let i = 0; i < rings; i++) {
          const local = ease - i * 0.15
          if (local <= 0) continue
          ctx.beginPath()
          ctx.arc(width / 2, height / 2, local * Math.max(width, height) * 0.62, 0, Math.PI * 2)
          ctx.lineWidth = (1 - k) * 11 + 1.5
          ctx.strokeStyle = rgba(color, (1 - k) * 0.55 * (1 - i * 0.3))
          ctx.stroke()
        }
        ctx.fillStyle = rgba(color, (1 - k) * 0.17 * power)
        ctx.fillRect(0, 0, width, height)
      }

      /* 8. 缓慢下移的扫描线 */
      const scanY = ((T * 0.15) % 1.4) * height
      const scan = ctx.createLinearGradient(0, scanY - 70, 0, scanY + 70)
      scan.addColorStop(0, rgba(color, 0))
      scan.addColorStop(0.5, rgba(color, 0.11 * power))
      scan.addColorStop(1, rgba(color, 0))
      ctx.fillStyle = scan
      ctx.fillRect(0, scanY - 70, width, 140)

      ctx.restore()
      raf = requestAnimationFrame(draw)
    }

    const kick = (): void => {
      if (looping) return
      looping = true
      raf = requestAnimationFrame(draw)
    }
    kickRef.current = kick
    kick()
    return () => {
      looping = false
      kickRef.current = null
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [])

  return <canvas ref={canvasRef} aria-hidden="true" style={{ pointerEvents: 'none', display: 'block' }} />
}
