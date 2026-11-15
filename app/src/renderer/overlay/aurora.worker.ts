/**
 * 半分辨率 WebGL2 流光边框。画布在主线程转成 OffscreenCanvas 后交给这里，
 * 主进程不再参与每一帧。关掉或淡出之后就停掉 requestAnimationFrame。
 */

type Mode = 'off' | 'wake' | 'think' | 'act' | 'mouse'
type Fx = 'off' | 'soft' | 'vivid'

const COLORS: Record<Exclude<Mode, 'off'>, [number, number, number]> = {
  wake: [58, 245, 166],
  think: [96, 172, 255],
  act: [255, 180, 84],
  mouse: [255, 138, 24],
}

const VERT = `#version 300 es
layout(location=0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`

const FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform vec3 uColor;
uniform float uTime;
uniform float uPower;
uniform float uThick;
uniform float uRipple;
out vec4 frag;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

void main() {
  vec2 px = gl_FragCoord.xy;
  float d = min(min(px.x, uRes.x - px.x), min(px.y, uRes.y - px.y));
  float edge = exp(-d / max(uThick, 1.0));
  float n1 = noise(vec2(px.x * 0.018 + uTime * 0.16, px.y * 0.014 - uTime * 0.07));
  float n2 = noise(vec2(px.y * 0.028 - uTime * 0.11, uTime * 0.05 + px.x * 0.012));
  float n3 = noise(vec2((px.x + px.y) * 0.01 + uTime * 0.08, uTime * 0.2));
  float aurora = edge * (0.35 + 0.4 * n1 + 0.25 * n2) * (0.65 + 0.35 * n3);
  vec2 uv = px / uRes;
  vec2 p = (uv - 0.5) * vec2(uRes.x / max(uRes.y, 1.0), 1.0);
  float radius = length(p);
  float ring = exp(-abs(radius - uRipple * 0.9) * 26.0) * (1.0 - uRipple);
  float alpha = clamp(aurora * uPower + ring * uPower, 0.0, 1.0);
  frag = vec4(uColor * alpha, alpha);
}
`

let canvas: OffscreenCanvas | null = null
let gl: WebGL2RenderingContext | null = null
let program: WebGLProgram | null = null
let raf = 0
let running = false
let mode: Mode = 'off'
let fx: Fx = 'vivid'
let bands = [0, 0, 0, 0, 0, 0, 0, 0]
const color = [58, 245, 166]
let target = [58, 245, 166]
let ripple = 1
let power = 0
let last = 0

function compile(type: number, source: string): WebGLShader | null {
  if (!gl) return null
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader)
    return null
  }
  return shader
}

function boot(surface: OffscreenCanvas): boolean {
  canvas = surface
  gl = surface.getContext('webgl2', {
    alpha: true,
    antialias: false,
    premultipliedAlpha: true,
    powerPreference: 'low-power',
  })
  if (!gl) return false
  const vs = compile(gl.VERTEX_SHADER, VERT)
  const fs = compile(gl.FRAGMENT_SHADER, FRAG)
  if (!vs || !fs) return false
  program = gl.createProgram()
  if (!program) return false
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return false
  const buffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  return true
}

function level(): number {
  let sum = 0
  for (const band of bands) sum += band
  return Math.min(1, sum / bands.length)
}

function frame(now: number): void {
  if (!running || !gl || !canvas) return
  if (now - last < 32) {
    raf = requestAnimationFrame(frame)
    return
  }
  const dt = Math.min(0.05, (now - last) / 1000 || 0.016)
  last = now
  const look = mode === 'off' ? null : COLORS[mode]
  if (look) target = look
  for (let i = 0; i < 3; i++) color[i] += (target[i] - color[i]) * 0.12
  const audio = level()
  const scale = fx === 'soft' ? 0.55 : fx === 'off' ? 0 : 1
  const goal = look ? (0.72 + audio * 0.35) * scale : 0
  power += (goal - power) * 0.1
  if (ripple < 1) ripple = Math.min(1, ripple + dt * 1.15)
  if (!look && power < 0.02 && ripple >= 0.98) {
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    running = false
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    return
  }
  gl.viewport(0, 0, canvas.width, canvas.height)
  gl.clearColor(0, 0, 0, 0)
  gl.clear(gl.COLOR_BUFFER_BIT)
  gl.useProgram(program)
  const loc = (name: string): WebGLUniformLocation | null =>
    program ? (gl?.getUniformLocation(program, name) ?? null) : null
  gl.uniform2f(loc('uRes'), canvas.width, canvas.height)
  gl.uniform3f(loc('uColor'), color[0] / 255, color[1] / 255, color[2] / 255)
  gl.uniform1f(loc('uTime'), now / 1000)
  gl.uniform1f(loc('uPower'), power)
  gl.uniform1f(
    loc('uThick'),
    (fx === 'soft' ? 16 : 26) + audio * (fx === 'vivid' ? 48 : 22) + (mode === 'mouse' ? 12 : 0),
  )
  gl.uniform1f(loc('uRipple'), ripple)
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  raf = requestAnimationFrame(frame)
}

function start(): void {
  if (running) return
  running = true
  last = 0
  raf = requestAnimationFrame(frame)
}

type Incoming =
  | { type: 'init'; canvas: OffscreenCanvas; width: number; height: number }
  | { type: 'resize'; width: number; height: number }
  | { type: 'state'; mode: Mode; fx: Fx }
  | { type: 'bands'; bands: number[] }

self.onmessage = (event: MessageEvent<Incoming>) => {
  const msg = event.data
  if (!msg) return
  if (msg.type === 'init') {
    canvas = msg.canvas
    canvas.width = Math.max(2, Math.floor(msg.width / 2))
    canvas.height = Math.max(2, Math.floor(msg.height / 2))
    if (!boot(canvas)) {
      self.postMessage({ type: 'nogpu' })
      return
    }
    start()
    return
  }
  if (msg.type === 'resize' && canvas) {
    canvas.width = Math.max(2, Math.floor(msg.width / 2))
    canvas.height = Math.max(2, Math.floor(msg.height / 2))
    return
  }
  if (msg.type === 'state') {
    if (msg.mode !== mode && msg.mode !== 'off') ripple = 0
    mode = msg.mode
    fx = msg.fx
    if (fx === 'off') mode = 'off'
    if (mode !== 'off' || power > 0.02) start()
    return
  }
  if (msg.type === 'bands' && Array.isArray(msg.bands)) bands = msg.bands
}
