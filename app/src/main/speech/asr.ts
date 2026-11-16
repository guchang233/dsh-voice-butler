/**
 * 语音识别：四家厂商。
 *
 *   硅基流动   POST https://api.siliconflow.cn/v1/audio/transcriptions            (multipart)
 *   智谱       POST https://open.bigmodel.cn/api/paas/v4/audio/transcriptions     (multipart)
 *   阿里云百炼 POST https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
 *              （OpenAI 兼容：base64 data URI 传本地 WAV，不需要 WebSocket）
 *   DeepSeek   POST {baseUrl}/v1/tools/asr                                       (multipart)
 *
 * 四家都只回整段文本，所以「边说边出字」由 online-asr.ts 用 LocalAgreement-2 反复调用这里。
 */

import type { AsrProvider } from '../../shared/ipc'

const SILICONFLOW_BASE = 'https://api.siliconflow.cn/v1'
const DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com'

/**
 * 单次请求的上限。
 *
 * 伪流式是一条 await 链：一次请求挂住，OnlineAsr 的 flying 就一直为真，
 * 后面所有 kick 都被挡掉，finish() 也会一直 await —— 管家会永远卡在「在想」。
 */
const VERIFY_TIMEOUT_MS = 10_000
const TRANSCRIBE_TIMEOUT_MS = 15_000

export type TranscribeOptions = {
  baseUrl?: string
  model?: string
}

function defaultModel(provider: AsrProvider): string {
  if (provider === 'siliconflow') return 'FunAudioLLM/SenseVoiceSmall'
  if (provider === 'dashscope') return 'qwen3-asr-flash'
  return 'default'
}

/** 确认 Key 有效且不消耗识别额度：前两家查模型列表，百炼走 OpenAI 兼容的 /models */
export async function verifyAsrKey(
  provider: AsrProvider,
  apiKey: string,
  options?: TranscribeOptions
): Promise<void> {
  const url =
    provider === 'siliconflow'
      ? `${SILICONFLOW_BASE}/models`
      : provider === 'dashscope'
        ? `${DASHSCOPE_BASE}/compatible-mode/v1/models`
        : `${(options?.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '')}/models`

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
  options?: TranscribeOptions
): Promise<string> {
  const model = (options?.model || '').trim() || defaultModel(provider)

  if (provider === 'dashscope') {
    return transcribeDashScope(apiKey, wav, model)
  }

  const url =
    provider === 'siliconflow'
      ? `${SILICONFLOW_BASE}/audio/transcriptions`
      : `${(options?.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '')}/v1/tools/asr`

  const form = new FormData()
  if (provider !== 'deepseek') form.append('model', model)
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

/** 百炼：OpenAI 兼容的多模态接口，音频用 base64 data URI 直接塞进去 */
async function transcribeDashScope(apiKey: string, wav: Buffer, model: string): Promise<string> {
  const data = `data:audio/wav;base64,${wav.toString('base64')}`
  const res = await fetch(`${DASHSCOPE_BASE}/compatible-mode/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        {
          role: 'user',
          content: [{ type: 'input_audio', input_audio: { data } }],
        },
      ],
    }),
    signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
  })

  if (!res.ok) throw new Error(await describe('dashscope', res))
  const raw = await res.text()
  try {
    const body = JSON.parse(raw) as {
      choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>
    }
    const content = body.choices?.[0]?.message?.content
    const text = Array.isArray(content) ? content.map((part) => part.text ?? '').join('') : (content ?? '')
    return cleanTranscript(text)
  } catch {
    throw new Error('语音识别返回了非 JSON 内容：' + raw.slice(0, 160))
  }
}

/** SenseVoice / GLM-ASR / Qwen-ASR 有时会在正文前后带 <|zh|> 这类标记，不该进对话 */
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
    provider === 'siliconflow' ? '硅基流动' : provider === 'dashscope' ? '阿里云百炼' : '语音识别'
  const map: Record<number, string> = {
    400: '这段音频服务端无法识别（400）',
    401: `${who} API Key 无效（401）`,
    402: '账户余额不足（402）',
    403: '没有使用该模型的权限（403）',
    413: '音频太大（413）',
    429: '请求过于频繁（429）',
  }
  const head = map[res.status] ?? `${who}识别失败（HTTP ${res.status}）`
  return detail ? `${head}：${detail.slice(0, 200)}` : head
}
