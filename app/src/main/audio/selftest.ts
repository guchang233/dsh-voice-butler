import { app } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WAKE_WORD } from '../../shared/ipc'
import { logError, logInfo } from '../log'
import { getApiKey, getSettings } from '../store'
import { createKeywordWatcher } from './kws'

/** 把 16k s16 的样本写成 WAV，方便离线反复试参数 */
function writeWav(path: string, samples: Int16Array, sampleRate = 16000): void {
  const buffer = Buffer.alloc(44 + samples.length * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + samples.length * 2, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(samples.length * 2, 40)
  for (let i = 0; i < samples.length; i++) buffer.writeInt16LE(samples[i], 44 + i * 2)
  writeFileSync(path, buffer)
}

/** 24k → 16k 线性重采样（只用于自测，不走实时链路） */
function resample(input: Int16Array, from: number, to: number): Int16Array {
  const ratio = from / to
  const length = Math.floor(input.length / ratio)
  const out = new Int16Array(length)
  for (let i = 0; i < length; i++) {
    const pos = i * ratio
    const base = Math.floor(pos)
    const frac = pos - base
    const a = input[base] ?? 0
    const b = input[base + 1] ?? a
    out[i] = Math.round(a + (b - a) * frac)
  }
  return out
}

/**
 * 自测：让云端 TTS 念一遍唤醒词，再把音频灌回本地唤醒词引擎，看能不能命中。
 * 用来验证「大肥鱼」这条拼音 token 串到底对不对，不依赖真人对着麦克风说话。
 */
export async function runWakeWordSelfTest(): Promise<void> {
  const key = getApiKey()
  const settings = getSettings()
  if (!key) {
    logError('selftest', '没有 API Key，跳过唤醒词自测')
    return
  }

  const watcher = createKeywordWatcher({ label: 'kws-selftest' })
  // 播报中用的那个更灵敏的引擎也一起验一遍：它要是认不出唤醒词，打断就是摆设
  const bargeWatcher = createKeywordWatcher({ score: 1.2, threshold: 0.12, label: 'kws-barge-selftest' })
  if (!watcher) {
    logError('selftest', '唤醒词引擎未就绪')
    return
  }

  try {
    const res = await fetch(`${settings.baseUrl.replace(/\/+$/, '')}/v1/tools/tts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: WAKE_WORD,
        voice_id: 'stella',
        format: 'pcm',
        filter_markdown: true
      })
    })
    if (!res.ok) {
      logError('selftest', 'TTS 失败 HTTP ' + res.status)
      return
    }
    const raw = Buffer.from(await res.arrayBuffer())
    const pcm24 = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 2))
    const pcm16 = resample(pcm24, 24000, 16000)

    // 真实场景里说完话后面还有静音，流式解码靠它把最后一个 token 吐出来；
    // 自测样本是戛然而止的，必须自己补一段尾巴
    const tail = Math.round(16000 * 0.9)
    const padded = new Int16Array(pcm16.length + tail)
    padded.set(pcm16)

    try {
      writeWav(join(app.getPath('userData'), 'selftest-wake.wav'), padded)
      logInfo('selftest', '样本已落盘：selftest-wake.wav')
    } catch {
      // 落盘失败不影响检测
    }

    let hit: string | null = null
    let bargeHit: string | null = null
    for (let offset = 0; offset < padded.length; offset += 1600) {
      const chunk = padded.subarray(offset, Math.min(offset + 1600, padded.length))
      if (!hit) {
        const result = watcher.feed(chunk)
        if (result) hit = result
      }
      if (bargeWatcher && !bargeHit) {
        const result = bargeWatcher.feed(chunk)
        if (result) bargeHit = result
      }
      if (hit && (bargeHit || !bargeWatcher)) break
    }
    logInfo(
      'selftest',
      `唤醒词自测：${padded.length} 样本 → 待机引擎 ${hit ? '命中 ' + hit : '未命中'}；` +
        `播报引擎 ${bargeWatcher ? (bargeHit ? '命中 ' + bargeHit : '未命中') : '（未就绪）'}`
    )

    // 顺手验证 ASR：把同一段音频送云端识别，看回来是不是「大肥鱼」
    try {
      const wav = Buffer.alloc(44 + padded.length * 2)
      wav.write('RIFF', 0)
      wav.writeUInt32LE(36 + padded.length * 2, 4)
      wav.write('WAVE', 8)
      wav.write('fmt ', 12)
      wav.writeUInt32LE(16, 16)
      wav.writeUInt16LE(1, 20)
      wav.writeUInt16LE(1, 22)
      wav.writeUInt32LE(16000, 24)
      wav.writeUInt32LE(32000, 28)
      wav.writeUInt16LE(2, 32)
      wav.writeUInt16LE(16, 34)
      wav.write('data', 36)
      wav.writeUInt32LE(padded.length * 2, 40)
      for (let i = 0; i < padded.length; i++) wav.writeInt16LE(padded[i], 44 + i * 2)

      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'recording.wav')
      const asrRes = await fetch(`${settings.baseUrl.replace(/\/+$/, '')}/v1/tools/asr`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form
      })
      if (asrRes.ok) {
        const body = (await asrRes.json()) as { text?: string }
        logInfo('selftest', 'ASR 自测：' + (body.text ?? '(空)'))
      } else {
        logError('selftest', 'ASR 失败 HTTP ' + asrRes.status)
      }
    } catch (error) {
      logError('selftest ASR 异常', error)
    }
  } catch (error) {
    logError('selftest 异常', error)
  }
}
