#!/usr/bin/env node
/**
 * 手工验证：不用麦克风，直接把一句话投进 DSH 管家会话，把它回的帧打出来。
 *
 *   node scripts/probe-voice.mjs "现在几点了"
 *   node scripts/probe-voice.mjs "打开记事本" --origin http://127.0.0.1:63563
 *
 * 走的是语音壳完全一样的那条路：POST /voice/say + GET /voice/frames 长轮询。
 * 所以这个脚本能跑通，壳就一定能跑通（剩下的只是麦克风和喇叭）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const words = []
let explicitOrigin = ''
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--origin') {
    explicitOrigin = args[i + 1] ?? ''
    i += 1
    continue
  }
  words.push(args[i])
}
const text = words.join(' ').trim()

function originFromState() {
  const file = path.join(os.homedir(), '.dsh', 'butler-bridge', 'endpoint.json')
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (typeof parsed.origin === 'string' && parsed.origin) return parsed.origin.replace(/\/+$/, '')
  } catch {
    /* 没有就退回默认端口 */
  }
  return 'http://127.0.0.1:63563'
}

const origin = (explicitOrigin || originFromState()).replace(/\/+$/, '')

if (!text) {
  console.error('用法：node scripts/probe-voice.mjs "一句话" [--origin http://127.0.0.1:63563]')
  process.exit(2)
}

const label = (frame) => {
  const extra = frame.text ?? frame.args ?? frame.detail ?? frame.message ?? frame.reason ?? ''
  return `[${frame.seq}] ${frame.t}${frame.phase ? '/' + frame.phase : ''}` + (extra ? `  ${String(extra).slice(0, 160)}` : '')
}

const main = async () => {
  const ping = await fetch(`${origin}/voice/ping`).then((r) => r.json())
  console.log('bridge:', JSON.stringify(ping))
  if (!ping.sessionId) console.log('提示：还没有管家会话，投递时会自动建一条')

  const say = await fetch(`${origin}/voice/say`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ text })
  }).then((r) => r.json())
  console.log('say:', JSON.stringify(say))
  if (!say.ok) process.exit(1)

  let cursor = ping.cursor ?? 0
  const deadline = Date.now() + 180_000
  let sawReply = false
  while (Date.now() < deadline) {
    const url = `${origin}/voice/frames?cursor=${cursor}&wait=20000`
    const page = await fetch(url, { signal: AbortSignal.timeout(30_000) }).then((r) => r.json())
    cursor = page.cursor
    for (const frame of page.frames ?? []) {
      console.log(label(frame))
      if (frame.t === 'reply') sawReply = true
      if (frame.t === 'approval') {
        console.log(`   ↑ 需要确认（${frame.tool}）；面板上点，或者 POST /voice/approve`)
      }
    }
    if (sawReply && page.running === false) break
  }
  if (!sawReply) console.log('（没等到 reply；看看面板或 DSH 会话里有没有报错）')
}

main().catch((error) => {
  console.error('失败：', error?.message ?? error)
  process.exit(1)
})
