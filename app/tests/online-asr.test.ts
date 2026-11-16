import { describe, expect, it } from 'vitest'
import {
  HypothesisBuffer,
  OnlineAsr,
  detokenize,
  present,
  stripLeadingWake,
  tokenize,
} from '../src/main/speech/online-asr'

describe('HypothesisBuffer（LocalAgreement-2）', () => {
  it('只提交两次识别的最长公共前缀', () => {
    const buffer = new HypothesisBuffer()
    expect(buffer.insert(tokenize('打开记事'))).toEqual([])
    expect(detokenize(buffer.partial())).toBe('打开记事')

    expect(detokenize(buffer.insert(tokenize('打开记事本')))).toBe('打开记事')
    expect(detokenize(buffer.committed)).toBe('打开记事')
    expect(detokenize(buffer.partial())).toBe('本')

    // 中途改口：已经提交的前缀不动
    buffer.insert(tokenize('打开记日了'))
    expect(detokenize(buffer.committed)).toBe('打开记事')
  })

  it('空结果不会把已提交的内容擦掉', () => {
    const buffer = new HypothesisBuffer()
    buffer.insert(tokenize('在听'))
    buffer.insert([])
    expect(detokenize(buffer.partial())).toBe('在听')
  })
})

describe('分词往返', () => {
  it('中英混排按习惯加空格', () => {
    expect(detokenize(tokenize('打开 Chrome 浏览器'))).toBe('打开 Chrome 浏览器')
    expect(detokenize(tokenize('打开Chrome'))).toBe('打开 Chrome')
    expect(detokenize(tokenize('you.'))).toBe('you.')
  })
})

describe('唤醒词剥离', () => {
  it('只去开头的那一个，后面的保留', () => {
    expect(stripLeadingWake('大肥鱼，打开记事本')).toBe('打开记事本')
    expect(stripLeadingWake('大飞鱼 现在几点')).toBe('现在几点')
    expect(stripLeadingWake('打开大肥鱼的文件')).toBe('打开大肥鱼的文件')
  })

  it('字幕里也把开头的唤醒词抹掉', () => {
    expect(present('大肥鱼，打开', '记事本')).toEqual({ committed: '打开', partial: '记事本' })
    expect(present('大肥', '鱼打开记事本')).toEqual({ committed: '', partial: '打开记事本' })
  })
})

describe('OnlineAsr 调度', () => {
  it('攒够一个 chunk 才调用，收尾以整段重识别为准', async () => {
    const scripts = ['打开记事', '打开记事本', '打开记事本']
    let calls = 0
    const updates: string[] = []
    const asr = new OnlineAsr(async () => {
      const text = scripts[Math.min(calls, scripts.length - 1)]
      calls += 1
      return text
    })
    asr.onUpdate((shown) => updates.push(`${shown.committed}|${shown.partial}`))
    asr.markHeard()

    asr.push(new Int16Array(8000))
    asr.kick()
    await asr.idle()
    expect(calls).toBe(0)

    asr.push(new Int16Array(8000))
    asr.kick()
    await asr.idle()
    expect(calls).toBe(1)
    expect(updates).toEqual(['|打开记事'])

    asr.push(new Int16Array(16000))
    asr.kick()
    await asr.idle()
    expect(updates.at(-1)).toBe('打开记事|本')

    await expect(asr.finish()).resolves.toBe('打开记事本')
  })

  it('收尾时把唤醒词去掉', async () => {
    const asr = new OnlineAsr(async () => '大肥鱼，把音量调到一半')
    asr.push(new Int16Array(16000))
    await expect(asr.finish()).resolves.toBe('把音量调到一半')
  })

  it('识别失败时不会一直抛，收尾把错误交出去', async () => {
    const asr = new OnlineAsr(async () => {
      throw new Error('429')
    })
    asr.markHeard()
    asr.push(new Int16Array(16000))
    asr.kick()
    await asr.idle()
    await expect(asr.finish()).rejects.toThrow('429')
  })
})
