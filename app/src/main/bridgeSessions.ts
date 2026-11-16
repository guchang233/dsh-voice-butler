import type { Result } from '../shared/ipc'

/** 面板 ↔ 桥：会话列表、切换会话、模型目录、选择模型（都转发给 DSH） */

export type BridgeSession = {
  id: string
  cwd: string
  updatedAt: number
  running: boolean
  blank: boolean
  current: boolean
}

export type BridgeModel = {
  provider: string
  providerName: string
  id: string
  name: string
  description: string
  effort: string | null
  efforts: Array<{ id: string; name: string }>
}

export type BridgeModelCatalog = {
  models: BridgeModel[]
  current: { provider: string; model: string; effort: string | null } | null
  failures: Array<{ id: string; name: string; message: string }>
}

export type BridgeLike = {
  listSessions: () => Promise<BridgeSession[]>
  switchSession: (sessionId: string) => Promise<void>
  listModels: () => Promise<BridgeModelCatalog>
  selectModel: (provider: string, model: string, effort?: string) => Promise<void>
}

export type BridgeShell = {
  origin: string
  authHeaders: () => Record<string, string>
  post: (path: string, body: string, timeoutMs: number) => Promise<unknown>
}

async function getJson<T>(shell: BridgeShell, path: string, timeoutMs: number): Promise<T> {
  const origin = shell.origin || ''
  const res = await fetch(`${origin}${path}`, {
    headers: shell.authHeaders(),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const body = (await res.json()) as { ok?: boolean; error?: string }
  if (!res.ok || body.ok === false) {
    throw new Error(body.error || `桥返回 HTTP ${res.status}`)
  }
  return body as T
}

export async function listSessions(shell: BridgeShell): Promise<BridgeSession[]> {
  const body = await getJson<{ items?: BridgeSession[] }>(shell, '/voice/sessions', 15_000)
  return body.items ?? []
}

export async function switchSession(shell: BridgeShell, sessionId: string): Promise<void> {
  const result = (await shell.post('/voice/session', JSON.stringify({ sessionId }), 15_000)) as Result
  if (result && result.ok === false) throw new Error(result.error ?? '切换失败')
}

export async function listModels(shell: BridgeShell): Promise<BridgeModelCatalog> {
  const body = await getJson<BridgeModelCatalog>(shell, '/voice/models', 25_000)
  return {
    models: body.models ?? [],
    current: body.current ?? null,
    failures: body.failures ?? [],
  }
}

export async function selectModel(
  shell: BridgeShell,
  provider: string,
  model: string,
  effort?: string
): Promise<void> {
  const payload: Record<string, string> = { provider, model }
  if (effort) payload.effort = effort
  const result = (await shell.post('/voice/model', JSON.stringify(payload), 25_000)) as Result
  if (result && result.ok === false) throw new Error(result.error ?? '选择模型失败')
}
