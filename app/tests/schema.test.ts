import { describe, expect, it } from 'vitest'
import { approveBody, sayBody } from '../../butler-bridge/lib/schema.js'

describe('桥接口校验', () => {
  it('空话和超长确认号会被拒绝', () => {
    expect(sayBody.safeParse({ text: '  ' }).success).toBe(false)
    expect(sayBody.safeParse({ text: '现在几点了' }).success).toBe(true)
    expect(approveBody.safeParse({ id: 'abc', allow: false }).success).toBe(true)
    expect(approveBody.safeParse({ id: '', allow: true }).success).toBe(false)
    expect(approveBody.safeParse({ id: 'abc', allow: 'yes' }).success).toBe(false)
  })
})
