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

function who(provider: AsrProvider): string {
  return provider === 'siliconflow' ? '硅基流动识别' : provider === 'dashscope' ? '阿里云百炼识别' : '语音识别'
}

function defaultModel(provider: AsrProvider): string {
  if (provider === 'siliconflow') return 'FunAudioLLM/SenseVoiceSmall'
  if (provider === 'dashscope') return 'qwen3-asr-flash'
  return 'default'
}

/** 0.5 秒静音 WAV：校验时用，费用约 0.0001 元 */
function silenceWav(): Buffer {
  const samples = 8000
  const buf = Buffer.alloc(44 + samples * 2)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + samples * 2, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(16000, 24)
  buf.writeUInt32LE(32000, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(samples * 2, 40)
  return buf
}

/**
 * 确认能真正用起来。
 *
 * 硅基流动 / DeepSeek 查模型列表（免费）；百炼的 /models 有时能过、真实识别却缺参数，
 * 所以百炼直接跑一次 0.5 秒静音识别——能出文本就说明 Key、模型、请求格式全对。
 */
export async function verifyAsrKey(
  provider: AsrProvider,
  apiKey: string,
  options?: TranscribeOptions
): Promise<void> {
  if (provider === 'dashscope') {
    await transcribe(provider, apiKey, silenceWav(), options)
    return
  }
  const url =
    provider === 'siliconflow'
      ? `${SILICONFLOW_BASE}/models`
      : `${(options?.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '')}/models`

  const res = await guard(who(provider), VERIFY_TIMEOUT_MS, () =>
    fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    }),
  )
  if (!res.ok) throw new Error(await describe(provider, res))
}

/** 把「The operation was aborted due to timeout」这种翻成人话 */
async function guard<T>(who: string, ms: number, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    const name = (error as { name?: string })?.name
    const message = error instanceof Error ? error.message : String(error)
    if (name === 'TimeoutError' || /aborted due to timeout/i.test(message)) {
      throw new Error(`${who}没回应（${Math.round(ms / 1000)} 秒超时），检查网络或换一家再试`)
    }
    if (name === 'AbortError') throw new Error(`${who}请求被取消了`)
    if (/fetch failed/i.test(message)) throw new Error(`${who}连不上，检查网络或代理`)
    throw error
  }
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

  const res = await guard(who(provider), TRANSCRIBE_TIMEOUT_MS, () =>
    fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    }),
  )

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
  const res = await guard('阿里云百炼识别', TRANSCRIBE_TIMEOUT_MS, () =>
    fetch(`${DASHSCOPE_BASE}/compatible-mode/v1/chat/completions`, {
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
    }),
  )

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
