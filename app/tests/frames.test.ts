import { describe, expect, it } from 'vitest'
import { createFrameLog } from '../../butler-bridge/lib/frames.js'

describe('帧游标和世代', () => {
  it('截断之后游标停在发出去的最后一帧，下一页还能接上', () => {
    const log = createFrameLog()
    for (let i = 0; i < 300; i++) log.push({ t: 'user', text: String(i) })
    const first = log.drain(0, log.epoch, 260)
    expect(first.truncated).toBe(true)
    expect(first.frames).toHaveLength(260)
    expect(first.cursor).toBe(260)
    expect(first.cursor).not.toBe(log.seq)
    const rest = log.drain(first.cursor, log.epoch, 260)
    expect(rest.frames).toHaveLength(40)
    expect(rest.cursor).toBe(300)
    expect(rest.truncated).toBe(false)
  })

  it('连续的 delta 合并后游标仍走到最后一条', () => {
    const log = createFrameLog()
    log.push({ t: 'delta', text: '你' })
    log.push({ t: 'delta', text: '好' })
    log.push({ t: 'delta', text: '。' })
    const page = log.drain(0, log.epoch, 260)
    expect(page.frames).toHaveLength(1)
    expect(page.frames[0]?.text).toBe('你好。')
    expect(page.cursor).toBe(3)
  })

  it('换会话后旧 epoch 会拿到 reset，而不是把新的 seq 0 当成没有新帧', () => {
    const log = createFrameLog()
    log.push({ t: 'user', text: '旧的' })
    const epoch = log.epoch
    log.reset()
    log.push({ t: 'reset' })
    const page = log.drain(99, epoch, 260)
    expect(page.reset).toBe(true)
    expect(page.epoch).toBe(epoch + 1)
    expect(page.frames.map((frame) => frame.t)).toContain('reset')
  })
})
