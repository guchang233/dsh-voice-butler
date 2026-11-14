// 验证「唤醒后不说话」不会卡死：灌静音 15 秒应自动退回待机，之后再喊唤醒词仍能命中
// 用法：node scripts/probe-recover.mjs <wavPath> [baseUrl]
import fs from 'node:fs'

const wavPath = process.argv[2]
const baseUrl = process.argv[3] || 'http://127.0.0.1:49891'
const sid = 'rec' + Date.now().toString(36)

const raw = fs.readFileSync(wavPath)
const pcm = raw.subarray(44, 44 + Math.floor((raw.length - 44) / 2) * 2)
const silence = Buffer.alloc(3200)

async function post(buf, extra = '') {
  const res = await fetch(`${baseUrl}/dsh-butler/audio?sid=${sid}${extra}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: buf
  })
  return res.json()
}

async function feed(buf, extra = '') {
  let last = {}
  for (let o = 0; o < buf.length; o += 3200) {
    last = await post(buf.subarray(o, Math.min(o + 3200, buf.length)), o === 0 ? extra : '')
    if (last.wake || last.asr || last.captureEnded) return last
  }
  return last
}

const first = await feed(pcm)
console.log('① 第一次唤醒:', first.wake ? '命中 ' + first.keyword : '未命中')

// 唤醒之后完全不说话，灌 16 秒静音
let ended = null
for (let i = 0; i < 160; i++) {
  const body = await post(silence)
  if (body.captureEnded) {
    ended = i
    break
  }
}
console.log('② 静音后自动收尾:', ended === null ? '没有（可能卡住）' : `第 ${ended} 片（约 ${(ended / 10).toFixed(1)} 秒）`)

const second = await feed(pcm)
console.log('③ 再喊一次:', second.wake ? '命中 ' + second.keyword : '未命中（仍卡在收音态）')
