import { useEffect, useMemo, useState } from 'react'
import type { PeekData } from '../../shared/ipc'

/**
 * 右键悬浮球弹出的小卡片：**峰谷时段** + **账户余额**。
 * 数据由主进程算好推过来（`peek:data`），这里只负责显示与倒计时。
 */

function money(currency: string, value: string): string {
  const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : `${currency} `
  const num = Number(value)
  const text = Number.isFinite(num) ? num.toFixed(2) : value
  return `${symbol}${text}`
}

function human(ms: number): string {
  if (ms <= 0) return '刚刚'
  const totalMinutes = Math.ceil(ms / 60_000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours <= 0) return `${minutes} 分钟`
  if (minutes === 0) return `${hours} 小时`
  return `${hours} 小时 ${minutes} 分`
}

export default function Peek(): JSX.Element {
  const [data, setData] = useState<PeekData | null>(null)
  const [now, setNow] = useState(Date.now())

  useEffect(
    () =>
      window.api.onPeekData((next) => {
        setData(next)
        setNow(Date.now())
      }),
    [],
  )

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const remain = useMemo(() => {
    if (!data) return 0
    return Math.max(0, data.pricing.nextAt - now)
  }, [data, now])

  return (
    <div className="peek" onClick={() => window.api.hidePeek()} title="点一下收起">
      <div className="peek-head">
        <span className="peek-title">管家 · 现在</span>
        {data && (
          <span className={data.pricing.peak ? 'peek-tag peak' : 'peek-tag'}>
            <i />
            {data.pricing.label}
          </span>
        )}
      </div>

      {!data ? (
        <div className="peek-skeleton">正在看…</div>
      ) : (
        <>
          <div className="peek-balance">
            {data.balance.ok ? (
              <>
                <span className="peek-money">{money(data.balance.currency, data.balance.total)}</span>
                <span className="peek-sub">
                  赠金 {money(data.balance.currency, data.balance.granted)} · 充值{' '}
                  {money(data.balance.currency, data.balance.toppedUp)}
                  {data.balance.available ? '' : ' · 账户不可用'}
                </span>
              </>
            ) : (
              <>
                <span className="peek-money dim">余额 —</span>
                <span className="peek-sub">{data.balance.error}</span>
              </>
            )}
          </div>

          <div className="peek-rule" />

          <div className="peek-pricing">
            <span className="peek-sub">{data.pricing.hint}</span>
            <span className="peek-count">
              {remain > 0 ? `${human(remain)}后${data.pricing.nextLabel}` : '时段刚切换'}
            </span>
          </div>
        </>
      )}
    </div>
  )
}
