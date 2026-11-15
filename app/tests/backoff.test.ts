import { describe, expect, it } from 'vitest'
import { nextBackoff } from '../src/shared/backoff'

describe('重连退避', () => {
  it('等待时间带抖动，下一次比这次更长，但有上限', () => {
    const first = nextBackoff(1500, 0)
    const jittered = nextBackoff(1500, 1)
    expect(first.waitMs).toBe(1500)
    expect(jittered.waitMs).toBeCloseTo(1500 * 1.3)
    expect(jittered.nextMs).toBeGreaterThan(1500)
    const capped = nextBackoff(20_000, 0.5)
    expect(capped.nextMs).toBe(30_000)
  })
})
