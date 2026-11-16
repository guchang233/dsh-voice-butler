import { describe, expect, it } from 'vitest'
import { SentenceChunker, shapeSegment } from '../src/main/speech/tts'

describe('切分（TTS 用）', () => {
  it('强标点够短就断，让首句早点开口', () => {
    const chunker = new SentenceChunker()
    expect(chunker.push('你好，我是管家。')).toEqual(['你好，我是管家。'])
  })

  it('短逗号不断，攒到一定长度再在逗号处切', () => {
    const chunker = new SentenceChunker()
    expect(chunker.push('我们先看')).toEqual([])
    expect(chunker.push('一下这个文件，然后再说别的细节部分')).toEqual([
      '我们先看一下这个文件，'
    ])
    expect(chunker.flush()).toBe('然后再说别的细节部分')
  })

  it('没有标点也不会切碎，超长才在安全处硬切', () => {
    const chunker = new SentenceChunker()
    const cut = chunker.push('一'.repeat(60))
    expect(cut).toHaveLength(1)
    expect(cut[0].length).toBeGreaterThanOrEqual(40)
    expect(cut[0].length).toBeLessThanOrEqual(46)
  })

  it('flush 没有内容时返回 null（老契约）', () => {
    const chunker = new SentenceChunker()
    chunker.push('你好，我是管家。')
    expect(chunker.flush()).toBeNull()
  })
})

describe('每段音频的整形（消开关声）', () => {
  const rate = 24000
  function tone(ms: number, amplitude: number, leadMs = 0, tailMs = 0): Int16Array {
    const total = Math.round(((ms + leadMs + tailMs) / 1000) * rate)
    const out = new Int16Array(total)
    const start = Math.round((leadMs / 1000) * rate)
    const end = start + Math.round((ms / 1000) * rate)
    for (let i = start; i < end && i < total; i += 1) out[i] = amplitude
    return out
  }

  it('首尾静音被砍掉', () => {
    const shaped = shapeSegment(tone(200, 8000, 100, 100))
    expect(shaped.length).toBeLessThan(Math.round(0.42 * rate))
    expect(shaped.length).toBeGreaterThanOrEqual(Math.round(0.19 * rate))
  })

  it('开头和结尾的幅度被压到接近 0（不会有台阶）', () => {
    const shaped = shapeSegment(tone(300, 12000))
    expect(Math.abs(shaped[0])).toBeLessThan(400)
    expect(Math.abs(shaped[shaped.length - 1])).toBeLessThan(400)
  })

  it('中间部分保持原样', () => {
    const shaped = shapeSegment(tone(300, 12000))
    const middle = shaped[Math.floor(shaped.length / 2)]
    expect(Math.abs(middle)).toBe(12000)
  })
})
