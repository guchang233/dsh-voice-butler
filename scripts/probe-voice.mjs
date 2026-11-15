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

function loadEndpoint() {
  const file = path.join(os.homedir(), '.dsh', 'butler-bridge', 'endpoint.json')
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return {
      origin: typeof parsed.origin === 'string' ? parsed.origin.replace(/\/+$/, '') : '',
      token: typeof parsed.token === 'string' ? parsed.token.trim() : ''
    }
  } catch {
    return { origin: '', token: '' }
  }
}

const endpoint = loadEndpoint()
const origin = (explicitOrigin || endpoint.origin || 'http://127.0.0.1:63563').replace(/\/+$/, '')
const token = endpoint.token

function authHeaders(json) {
  const headers = {}
  if (json) headers['content-type'] = 'application/json; charset=utf-8'
  if (token) headers.authorization = `Bearer ${token}`
  return headers
}

if (!text) {
  console.error('用法：node scripts/probe-voice.mjs "一句话" [--origin http://127.0.0.1:63563]')
  process.exit(2)
}

const label = (frame) => {
  const extra = frame.text ?? frame.args ?? frame.detail ?? frame.message ?? frame.reason ?? ''
  return `[${frame.seq}] ${frame.t}${frame.phase ? '/' + frame.phase : ''}` + (extra ? `  ${String(extra).slice(0, 160)}` : '')
}

const main = async () => {
  const ping = await fetch(`${origin}/voice/ping`, { headers: authHeaders(false) }).then((r) => r.json())
  console.log('bridge:', JSON.stringify(ping))
  if (!token) console.log('提示：endpoint.json 里还没有 token，/voice/say 会被拒绝')
  if (!ping.sessionId) console.log('提示：还没有管家会话，投递时会自动建一条')

  const say = await fetch(`${origin}/voice/say`, {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify({ text })
  }).then((r) => r.json())
  console.log('say:', JSON.stringify(say))
  if (!say.ok) process.exit(1)

  let cursor = ping.cursor ?? 0
  let epoch = ping.epoch ?? 0
  const deadline = Date.now() + 180_000
  let sawReply = false
  while (Date.now() < deadline) {
    const url = `${origin}/voice/frames?cursor=${cursor}&epoch=${epoch}&wait=20000`
    const page = await fetch(url, { headers: authHeaders(false), signal: AbortSignal.timeout(30_000) }).then((r) =>
      r.json()
    )
    cursor = page.cursor
    if (typeof page.epoch === 'number') epoch = page.epoch
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
