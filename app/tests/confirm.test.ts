import { describe, expect, it } from 'vitest'
import {
  approvalPrompt,
  decideVoiceApproval,
  isDangerousApproval,
  judgeUtterance,
  tooCloseToPrompt,
} from '../src/shared/confirm'

describe('语音确认', () => {
  it('否定优先，整句才算同意', () => {
    for (const word of ['不行', '不可以', '不是', '不对', '不要', '取消']) {
      expect(judgeUtterance(word)).toBe('no')
      expect(decideVoiceApproval(word, false)).toBe('deny')
    }
    expect(judgeUtterance('可以')).toBe('yes')
    expect(judgeUtterance('好的')).toBe('yes')
    expect(judgeUtterance('我觉得可以')).toBe('unknown')
    expect(judgeUtterance('可以吗')).toBe('unknown')
    expect(decideVoiceApproval('可以', false)).toBe('allow')
  })

  it('危险操作只能在面板上点允许', () => {
    expect(isDangerousApproval('shell', '删除桌面上的文件')).toBe(true)
    expect(isDangerousApproval('notepad', '打开记事本')).toBe(false)
    expect(decideVoiceApproval('可以', true)).toBe('needs-click')
    expect(decideVoiceApproval('不行', true)).toBe('deny')
  })

  it('问句不含肯定词，和问句太像的识别要丢掉', () => {
    const prompt = approvalPrompt('删除桌面文件')
    expect(prompt).not.toMatch(/可以|好的|行吧|同意/)
    expect(tooCloseToPrompt(prompt, prompt)).toBe(true)
    expect(tooCloseToPrompt('取消', prompt)).toBe(false)
  })
})
