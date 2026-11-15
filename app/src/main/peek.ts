import type { PeekData } from '../shared/ipc'
import { computePricing } from '../shared/pricing'
import { logError } from './log'
import { getApiKey, getSettings } from './store'

/**
 * 右键悬浮球时那张小卡片的数据：**峰谷时段** + **账户余额**。
 *
 * 时段规则在 shared/pricing.ts（纯函数）；余额走官方 `GET /user/balance`，
 * 用设置里那把钥匙（和语音识别/合成是同一把）。
 */

const CACHE_MS = 20_000
const CACHE_FAIL_MS = 8_000

let cache: { at: number; data: PeekData } | null = null

type Balance =
  | { ok: true; currency: string; total: string; granted: string; toppedUp: string; available: boolean }
  | { ok: false; error: string }

async function fetchBalance(): Promise<Balance> {
  const key = getApiKey()
  if (!key) return { ok: false, error: '还没配钥匙' }
  const base = getSettings().baseUrl.replace(/\/+$/, '')
  try {
    const res = await fetch(`${base}/user/balance`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000)
    })
    if (!res.ok) {
      const map: Record<number, string> = {
        401: '钥匙无效（401）',
        402: '账户不可用（402）',
        429: '请求太频繁（429）'
      }
      return { ok: false, error: map[res.status] ?? `取余额失败（HTTP ${res.status}）` }
    }
    const body = (await res.json()) as {
      is_available?: boolean
      balance_infos?: Array<{
        currency?: string
        total_balance?: string
        granted_balance?: string
        topped_up_balance?: string
      }>
    }
    const infos = Array.isArray(body.balance_infos) ? body.balance_infos : []
    const info = infos.find((row) => row.currency === 'CNY') ?? infos[0]
    if (!info) return { ok: false, error: '接口没返回余额' }
    return {
      ok: true,
      currency: info.currency || 'CNY',
      total: info.total_balance ?? '0',
      granted: info.granted_balance ?? '0',
      toppedUp: info.topped_up_balance ?? '0',
      available: body.is_available !== false
    }
  } catch (error) {
    logError('peek.balance', error)
    return { ok: false, error: '网络不通' }
  }
}

/** 右键时调用；20 秒内重复右键直接用缓存，失败的结果缓存短一些 */
export async function buildPeekData(force = false): Promise<PeekData> {
  const now = Date.now()
  if (!force && cache && now - cache.at < CACHE_MS) {
    // 时段是算出来的，永远用最新的；余额沿用缓存
    return { ...cache.data, at: now, pricing: computePricing(now) }
  }
  const balance = await fetchBalance()
  const data: PeekData = { at: Date.now(), pricing: computePricing(), balance }
  cache = { at: Date.now(), data }
  if (!balance.ok) {
    // 失败别缓存太久，免得用户刚充完值还看到旧错误
    cache = { at: Date.now() - (CACHE_MS - CACHE_FAIL_MS), data }
  }
  return data
}
