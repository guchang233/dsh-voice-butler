import type { PeekPricing } from './ipc'

/**
 * DeepSeek 的峰谷定价时段（北京时间）。
 *
 *   工作日 09:00–12:00、14:00–18:00 是高峰；
 *   其余（含午间、夜间）是空闲；
 *   2026-08-23 起周末全天按空闲价。
 *
 * 纯函数，不碰 electron —— 好测，也方便渲染层自己算倒计时。
 */

const PEAK_START_AM = 9 * 60
const PEAK_END_AM = 12 * 60
const PEAK_START_PM = 14 * 60
const PEAK_END_PM = 18 * 60
/** 周末全天谷价从这天开始生效 */
const WEEKEND_OFFPEAK_FROM = Date.parse('2026-08-23T00:00:00+08:00')

/** 上海时间（UTC+8，无夏令时：平移后读 UTC 字段最稳） */
function shanghai(nowMs: number): { dow: number; minutes: number; dayStartMs: number } {
  const shifted = new Date(nowMs + 8 * 3_600_000)
  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
  const dayStartMs =
    nowMs - (minutes * 60_000 + shifted.getUTCSeconds() * 1000 + shifted.getUTCMilliseconds())
  return { dow: shifted.getUTCDay(), minutes, dayStartMs }
}

export function computePricing(nowMs: number = Date.now()): PeekPricing {
  const { dow, minutes, dayStartMs } = shanghai(nowMs)
  const weekendRule = nowMs >= WEEKEND_OFFPEAK_FROM
  const isWeekend = weekendRule && (dow === 0 || dow === 6)
  const inPeakWindow =
    (minutes >= PEAK_START_AM && minutes < PEAK_END_AM) ||
    (minutes >= PEAK_START_PM && minutes < PEAK_END_PM)
  const peak = !isWeekend && inPeakWindow

  const boundaries = [PEAK_START_AM, PEAK_END_AM, PEAK_START_PM, PEAK_END_PM]
  let nextMinute: number | null = null
  if (!isWeekend) {
    for (const boundary of boundaries) {
      if (boundary > minutes) {
        nextMinute = boundary
        break
      }
    }
  }

  // 今天的切换点都过了（或者今天是周末）：落到下一个工作日的 09:00
  let dayOffset = 0
  if (nextMinute === null) {
    nextMinute = PEAK_START_AM
    let probeDow = dow
    do {
      dayOffset += 1
      probeDow = (dow + dayOffset) % 7
    } while (weekendRule && (probeDow === 0 || probeDow === 6))
  }

  const nextAt = dayStartMs + nextMinute * 60_000 + dayOffset * 86_400_000
  const enterPeak = nextMinute === PEAK_START_AM || nextMinute === PEAK_START_PM

  return {
    peak,
    label: peak ? '高峰时段' : '空闲时段',
    hint: peak ? '全价' : isWeekend ? '周末全天谷价' : '约半价',
    nextLabel: enterPeak ? '进入高峰' : '回到空闲',
    nextAt,
    remainMs: Math.max(0, nextAt - nowMs)
  }
}
