/**
 * 帧缓冲。
 *
 * cursor 必须停在「这次真正发出去的最后一帧」，不能直接跳到最新 seq，
 * 否则 budget 截断之后中间的帧就再也读不到。
 * epoch 在换会话时 +1，长轮询拿旧 epoch 会拿到 reset，不会把新会话的 seq 0 当成「没有新帧」。
 */

/**
 * @typedef {object} DrainResult
 * @property {boolean} reset
 * @property {number} epoch
 * @property {number} cursor
 * @property {Array<Record<string, unknown>>} frames
 * @property {boolean} truncated
 */

export function createFrameLog(maxFrames = 4000) {
  /** @type {Array<Record<string, unknown> & { seq: number }>} */
  let frames = []
  let seq = 0
  let epoch = 1

  return {
    get seq() {
      return seq
    },
    get epoch() {
      return epoch
    },
    get size() {
      return frames.length
    },
    /** @param {Record<string, unknown>} frame */
    push(frame) {
      seq += 1
      frames.push({ ...frame, seq })
      if (frames.length > maxFrames) frames.splice(0, frames.length - maxFrames)
      return seq
    },
    reset() {
      frames = []
      seq = 0
      epoch += 1
    },
    /**
     * @param {number} sinceSeq
     * @param {number} sinceEpoch
     * @param {number} [budget]
     * @returns {DrainResult}
     */
    drain(sinceSeq, sinceEpoch, budget = 260) {
      if (!Number.isFinite(sinceEpoch) || sinceEpoch !== epoch) {
        return {
          reset: true,
          epoch,
          cursor: seq,
          frames: frames.map((frame) => ({ ...frame })),
          truncated: false
        }
      }

      const since = Number.isFinite(sinceSeq) ? sinceSeq : -1
      const firstSeq = frames.length ? frames[0].seq : 0
      if (since >= 0 && firstSeq > 0 && since < firstSeq - 1) {
        return {
          reset: true,
          epoch,
          cursor: seq,
          frames: frames.map((frame) => ({ ...frame })),
          truncated: false
        }
      }

      /** @type {Array<Record<string, unknown> & { seq: number }>} */
      const out = []
      let cursor = since
      let truncated = false
      for (const frame of frames) {
        if (frame.seq <= since) continue
        const last = out[out.length - 1]
        if (last && last.t === 'delta' && frame.t === 'delta') {
          last.text = String(last.text ?? '') + String(frame.text ?? '')
          last.seq = frame.seq
          cursor = frame.seq
          continue
        }
        if (out.length >= budget) {
          truncated = true
          break
        }
        out.push({ ...frame })
        cursor = frame.seq
      }
      return { reset: false, epoch, cursor, frames: out, truncated }
    }
  }
}
