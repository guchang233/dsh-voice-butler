/**
 * 语音识别：两家免费厂商 + 原来的 DeepSeek 通道。
 *
 *   硅基流动  https://api.siliconflow.cn/v1/audio/transcriptions   FunAudioLLM/SenseVoiceSmall
 *   智谱      https://open.bigmodel.cn/api/paas/v4/audio/transcriptions   glm-asr-2512（≤30 秒）
 *   DeepSeek  {baseUrl}/v1/tools/asr（老通道，留着兜底）
 *
 * 两家都只回整段文本，没有时间戳，所以「边说边出字」由 online-asr.ts 用
 * LocalAgreement-2 反复调用这里的 transcribe 拼出来。
 */

import type { AsrProvider } from '../../shared/ipc'

const SILICONFLOW_BASE = 'https://api.siliconflow.cn/v1'
const SILICONFLOW_MODEL = 'FunAudioLLM/SenseVoiceSmall'
const ZHIPU_BASE = 'https://open.bigmodel.cn/api/paas/v4'
const ZHIPU_MODEL = 'glm-asr-2512'

/**
 * 单次请求的上限。
 *
 * 伪流式是一条 await 链：一次请求挂住，OnlineAsr 的 flying 就一直为真，
 * 后面所有 kick 都被挡掉，finish() 也会一直 await —— 管家会永远卡在「在想」。
 */
const VERIFY_TIMEOUT_MS = 10_000
const TRANSCRIBE_TIMEOUT_MS = 12_000

type Endpoint = { url: string; model: string | null }

function endpointOf(provider: AsrProvider, baseUrl?: string): Endpoint {
  if (provider === 'siliconflow') {
    return { url: `${SILICONFLOW_BASE}/audio/transcriptions`, model: SILICONFLOW_MODEL }
  }
  if (provider === 'zhipu') {
    return { url: `${ZHIPU_BASE}/audio/transcriptions`, model: ZHIPU_MODEL }
  }
  const base = (baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '')
  return { url: `${base}/v1/tools/asr`, model: null }
}

/** 确认 Key 有效但不动识别额度：前两家查模型列表，DeepSeek 走它自己的校验 */
export async function verifyAsrKey(
  provider: AsrProvider,
  apiKey: string,
  baseUrl?: string
): Promise<void> {
  const url =
    provider === 'siliconflow'
      ? `${SILICONFLOW_BASE}/models`
      : provider === 'zhipu'
        ? `${ZHIPU_BASE.replace('/paas/v4', '')}/paas/v4/models`
        : `${(baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '')}/models`

  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(await describe(provider, res))
}

export async function transcribe(
  provider: AsrProvider,
  apiKey: string,
  wav: Buffer,
  baseUrl?: string
): Promise<string> {
  const { url, model } = endpointOf(provider, baseUrl)
  const form = new FormData()
  if (model) form.append('model', model)
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'recording.wav')

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
  })

  if (!res.ok) throw new Error(await describe(provider, res))
  const raw = await res.text()
  try {
    const body = JSON.parse(raw) as { text?: string }
    return cleanTranscript(body.text ?? '')
  } catch {
    throw new Error('语音识别返回了非 JSON 内容：' + raw.slice(0, 160))
  }
}

/** SenseVoice / GLM-ASR 有时会在正文前后带 <|zh|> 这类标记，不该进对话 */
function cleanTranscript(text: string): string {
  return text
    .replace(/<\|[^|>]*\|>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

async function describe(provider: AsrProvider, res: Response): Promise<string> {
  let detail = ''
  try {
    detail = await res.text()
  } catch {
    detail = ''
  }
  try {
    const body = JSON.parse(detail) as { message?: string; error?: { message?: string } }
    detail = body.error?.message || body.message || detail
  } catch {
    // 不是 JSON 就保留原文
  }
  detail = detail.replace(/\s+/g, ' ').trim().slice(0, 200)

  const who =
    provider === 'siliconflow' ? '硅基流动' : provider === 'zhipu' ? '智谱' : '语音识别'
  const map: Record<number, string> = {
    400: '这段音频服务端无法识别（400，智谱要求单段 ≤30 秒）',
    401: `${who} API Key 无效（401）`,
    402: '账户余额不足（402）',
    403: '没有使用该模型的权限（403）',
    413: '音频太大（413）',
    429: '请求过于频繁（429）',
  }
  const head = map[res.status] ?? `${who}识别失败（HTTP ${res.status}）`
  return detail ? `${head}：${detail.slice(0, 200)}` : head
}
