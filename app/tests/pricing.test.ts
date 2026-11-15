import { describe, expect, it } from 'vitest'
import { computePricing } from '../src/shared/pricing'

describe('峰谷计价', () => {
  it('工作日上午 10 点是高峰', () => {
    const pricing = computePricing(Date.parse('2026-11-16T10:00:00+08:00'))
    expect(pricing.peak).toBe(true)
    expect(pricing.label).toBe('高峰时段')
  })

  it('2026-08-23 之后的周末上午不是高峰', () => {
    const pricing = computePricing(Date.parse('2026-11-14T10:00:00+08:00'))
    expect(pricing.peak).toBe(false)
    expect(pricing.hint).toBe('周末全天谷价')
  })

  it('工作日晚上是空闲，并给出下一次进入高峰的时间', () => {
    const now = Date.parse('2026-11-16T20:00:00+08:00')
    const pricing = computePricing(now)
    expect(pricing.peak).toBe(false)
    expect(pricing.nextLabel).toBe('进入高峰')
    expect(pricing.remainMs).toBeGreaterThan(0)
    expect(pricing.nextAt).toBeGreaterThan(now)
  })
})
