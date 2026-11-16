import { describe, expect, it } from 'vitest'
import { stripWav } from '../src/main/speech/tts'

function wavOf(payload: Uint8Array): Uint8Array {
  const header = new Uint8Array(44)
  const view = new DataView(header.buffer)
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) header[offset + i] = text.charCodeAt(i)
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + payload.length, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 24000, true)
  view.setUint32(28, 48000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, payload.length, true)
  const out = new Uint8Array(44 + payload.length)
  out.set(header, 0)
  out.set(payload, 44)
  return out
}

describe('百炼 TTS 的 WAV 剥头', () => {
  it('只留 data 段（24k/mono/16bit 的 PCM）', () => {
    const payload = new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0])
    const pcm = stripWav(wavOf(payload))
    expect([...pcm]).toEqual([...payload])
  })

  it('中间夹着 LIST 段也能跳过', () => {
    const payload = new Uint8Array([9, 0, 8, 0])
    const list = new Uint8Array(8 + 4)
    const ascii = 'LIST'
    for (let i = 0; i < 4; i += 1) list[i] = ascii.charCodeAt(i)
    new DataView(list.buffer).setUint32(4, 4, true)
    const base = wavOf(payload)
    const merged = new Uint8Array(base.length + list.length)
    merged.set(base.subarray(0, 36), 0) // RIFF+fmt
    merged.set(list, 36)
    merged.set(base.subarray(36), 36 + list.length)
    const pcm = stripWav(merged)
    expect([...pcm]).toEqual([...payload])
  })

  it('不是 WAV 就原样返回', () => {
    const raw = new Uint8Array([11, 22, 33])
    expect([...stripWav(raw)]).toEqual([...raw])
  })
})