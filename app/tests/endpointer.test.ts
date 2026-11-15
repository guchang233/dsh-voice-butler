import { describe, expect, it } from 'vitest'
import { createEndpointer, rms } from '../src/main/audio/vad'

const loud = (): Int16Array => new Int16Array(1600).fill(9000)
const quiet = (): Int16Array => new Int16Array(1600)

describe('端点检测', () => {
  it('说完静下来就收尾', () => {
    const ep = createEndpointer({ silenceMs: 200, minSpeechMs: 50, maxMs: 5000, minThreshold: 0.01 })
    expect(ep.push(loud()).done).toBe(false)
    expect(ep.speechStarted).toBe(true)
    ep.push(quiet())
    const done = ep.push(quiet())
    expect(done).toEqual({ done: true, reason: 'silence' })
  })

  it('一直没人说话也会因为超时收尾', () => {
    const ep = createEndpointer({ silenceMs: 2000, minSpeechMs: 400, maxMs: 250, minThreshold: 0.2 })
    ep.push(quiet())
    ep.push(quiet())
    const done = ep.push(quiet())
    expect(done.reason).toBe('timeout')
  })

  it('静音的均方根接近 0', () => {
    expect(rms(quiet())).toBe(0)
    expect(rms(loud())).toBeGreaterThan(0.1)
  })
})
