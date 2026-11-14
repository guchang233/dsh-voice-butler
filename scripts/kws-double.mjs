// 验证「连续两次唤醒」：第一次命中后 restart()，第二次还能命中吗
// 用法：node scripts/kws-double.mjs <wavPath>
import fs from 'node:fs'
import { createKeywordWatcher } from '../lib/kws.js'

const raw = fs.readFileSync(process.argv[2])
const pcm = raw.subarray(44, 44 + Math.floor((raw.length - 44) / 2) * 2)
const samples = new Int16Array(pcm.length / 2)
for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2)

const watcher = createKeywordWatcher(console)
if (!watcher) {
  console.log('引擎没起来')
  process.exit(1)
}

function feedAll(label) {
  for (let o = 0; o < samples.length; o += 1600) {
    const hit = watcher.feed(samples.subarray(o, Math.min(o + 1600, samples.length)))
    if (hit) {
      console.log(`${label} → 命中 ${hit}（第 ${o / 1600} 片）`)
      return true
    }
  }
  console.log(`${label} → 未命中`)
  return false
}

feedAll('第一次')
watcher.restart?.()
feedAll('restart 之后第二次')
watcher.restart?.()
feedAll('restart 之后第三次')
