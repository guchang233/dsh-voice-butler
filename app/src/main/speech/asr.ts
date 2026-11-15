/** DeepSeek 云端语音识别：POST /v1/tools/asr（multipart，WAV 16k mono s16le） */

export async function transcribe(baseUrl: string, apiKey: string, wav: Buffer): Promise<string> {
  const form = new FormData()
  const blob = new Blob([new Uint8Array(wav)], { type: 'audio/wav' })
  form.append('file', blob, 'recording.wav')

  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/tools/asr`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(45_000)
  })

  if (!res.ok) {
    throw new Error(await describe(res))
  }
  const raw = await res.text()
  try {
    const body = JSON.parse(raw) as { text?: string }
    return (body.text ?? '').trim()
  } catch {
    throw new Error('语音识别返回了非 JSON 内容：' + raw.slice(0, 160))
  }
}

async function describe(res: Response): Promise<string> {
  let detail = ''
  try {
    detail = (await res.text()).slice(0, 200)
  } catch {
    detail = ''
  }
  const map: Record<number, string> = {
    400: '这段音频服务端无法识别（400）',
    401: 'API Key 无效（401）',
    402: '账户余额不足（402）',
    413: '音频太大（413）',
    429: '请求过于频繁（429）'
  }
  const head = map[res.status] ?? `语音识别失败（HTTP ${res.status}）`
  return detail ? `${head}：${detail}` : head
}
