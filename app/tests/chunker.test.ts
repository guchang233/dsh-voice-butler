import { describe, expect, it } from 'vitest'
import { SentenceChunker } from '../src/main/speech/tts'

describe('SentenceChunker', () => {
  it('太短的句子先攒着，够长的才在句号处切开', () => {
    const short = new SentenceChunker(8, 42)
    expect(short.push('你好。')).toEqual([])
    expect(short.flush()).toBe('你好。')

    const chunker = new SentenceChunker(8, 42)
    const cut = chunker.push('这是一句足够长的话。后面还有')
    expect(cut).toEqual(['这是一句足够长的话。'])
    expect(chunker.flush()).toBe('后面还有')
    expect(chunker.flush()).toBeNull()
  })

  it('没有句号但超过上限也会切开', () => {
    const chunker = new SentenceChunker(8, 10)
    const cut = chunker.push('一二三四五六七八九十甲')
    expect(cut[0]).toHaveLength(10)
    expect(chunker.flush()).toBe('甲')
  })
})
