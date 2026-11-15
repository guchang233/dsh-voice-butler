/** 重连等待：指数增长，并加上最多 30% 的随机抖动，避免一堆客户端同时打过去 */
export function nextBackoff(
  currentMs: number,
  randomUnit: number,
  baseMs = 1500,
  capMs = 30_000,
): { waitMs: number; nextMs: number } {
  const unit = Math.max(0, Math.min(1, randomUnit))
  const waitMs = currentMs + unit * currentMs * 0.3
  const nextMs = Math.min(capMs, Math.max(baseMs, Math.round(currentMs * 1.8)))
  return { waitMs, nextMs }
}
