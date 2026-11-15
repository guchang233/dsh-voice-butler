/**
 * 语音确认。
 *
 * 旧正则把「可以 / 行 / 是」做成子串匹配，「不行 / 不可以 / 不是 / 不对」会同时命中同意和拒绝，
 * 然后被判成放行。这里改成：先看否定，同意必须整句命中白名单。
 * 危险操作不接受语音放行，只能在面板上点。
 */

export type UtteranceVerdict = 'yes' | 'no' | 'unknown'
export type ApprovalDecision = 'allow' | 'deny' | 'ignore' | 'needs-click'

const YES_WHOLE = new Set([
  '可以',
  '可以的',
  '可以啊',
  '行',
  '行的',
  '行吧',
  '好',
  '好的',
  '好啊',
  '好呀',
  '好吧',
  '好哒',
  '好滴',
  '嗯',
  '嗯嗯',
  '对',
  '对的',
  '是',
  '是的',
  '确认',
  '同意',
  '继续',
  '放行',
  '允许',
  'ok',
  'yes',
  'okay',
  '开吧',
  '关吧',
  '删吧',
  '准',
  '准了',
])

/** 否定优先：整句里只要出现这些，就绝不判成同意 */
const NEGATIVE = /不|别|取消|算了|停|等等|no|否|勿/

const DANGEROUS =
  /删|清空|格式化|关机|重启|卸载|覆盖|注册表|\brm\b|\bdel\b|remove|delete|format|shutdown|reboot|uninstall|\bdrop\b|mkfs|diskpart|taskkill|rmdir|erase|reg\s+delete|cipher|抹掉|重置|wipe|rd\s/i

export function normalizeUtterance(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s，,。.、！!？?~～…"'“”‘’]/g, '')
}

export function judgeUtterance(text: string): UtteranceVerdict {
  const clean = normalizeUtterance(text)
  if (!clean) return 'unknown'
  if (NEGATIVE.test(clean)) return 'no'
  if (YES_WHOLE.has(clean)) return 'yes'
  return 'unknown'
}

/** 工具名或给人看的理由里出现破坏性字样，就当作危险操作 */
export function isDangerousApproval(tool: string, reason: string): boolean {
  return DANGEROUS.test(`${tool} ${reason}`)
}

export function decideVoiceApproval(text: string, dangerous: boolean): ApprovalDecision {
  const verdict = judgeUtterance(text)
  if (verdict === 'no') return 'deny'
  if (dangerous) return verdict === 'yes' ? 'needs-click' : 'ignore'
  if (verdict === 'yes') return 'allow'
  return 'ignore'
}

/** 问句被麦克风收回来时丢掉，避免把「要不要取消」听成回答 */
export function tooCloseToPrompt(heard: string, prompt: string): boolean {
  const a = normalizeUtterance(heard)
  const b = normalizeUtterance(prompt)
  if (!a || !b) return false
  if (a === b) return true
  if (b.includes(a) && a.length >= 6) return true
  if (a.includes(b) && b.length >= 6) return true
  return diceCoefficient(a, b) >= 0.72
}

function diceCoefficient(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0
  const grams = (value: string): Map<string, number> => {
    const map = new Map<string, number>()
    for (let i = 0; i < value.length - 1; i++) {
      const gram = value.slice(i, i + 2)
      map.set(gram, (map.get(gram) ?? 0) + 1)
    }
    return map
  }
  const left = grams(a)
  const right = grams(b)
  let overlap = 0
  for (const [gram, count] of left) overlap += Math.min(count, right.get(gram) ?? 0)
  return (2 * overlap) / (a.length - 1 + (b.length - 1))
}

/** 问句本身不含白名单里的肯定词，避免念出来又被识别成同意 */
export function approvalPrompt(summary: string): string {
  const clean = summary.replace(/\s+/g, ' ').trim() || '这一步'
  return `要${clean}。请到面板上点。想拒绝就说取消。`
}
