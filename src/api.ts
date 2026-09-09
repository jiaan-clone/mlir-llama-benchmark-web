import { apiBaseUrl, apiKey } from './config'
import type {
  BackendKind,
  EngineResult,
  HealthResponse,
  InferenceMetrics,
  InferenceRequest,
  RuyiModel,
} from './types'

interface RawResponse {
  id?: string
  status?: string
  model?: string
  output?: unknown
  usage?: {
    input_tokens?: number
    output_tokens?: number
    total_tokens?: number
  }
  execution_metrics?: {
    latency_ms?: number
    time_to_first_token_ms?: number
    tokens_per_second?: number
    backend_model_id?: string
  }
  error?: { message?: string; code?: string } | string
}

function headers(): HeadersInit {
  return {
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  }
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function errorMessage(status: number, payload: unknown): string {
  if (payload && typeof payload === 'object' && 'error' in payload) {
    const error = (payload as { error?: unknown }).error
    if (typeof error === 'string' && error.trim()) return error
    if (error && typeof error === 'object' && 'message' in error) {
      const message = (error as { message?: unknown }).message
      if (typeof message === 'string' && message.trim()) return message
    }
  }
  if (typeof payload === 'string' && payload.trim()) return payload
  return `请求失败（HTTP ${status}）`
}

async function request(path: string, init: RequestInit = {}, timeoutMs = 120_000): Promise<unknown> {
  const controller = new AbortController()
  const parentSignal = init.signal
  let timedOut = false
  const timeoutId = globalThis.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onParentAbort = () => controller.abort()
  parentSignal?.addEventListener('abort', onParentAbort, { once: true })
  let response: Response
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { ...headers(), ...(init?.headers || {}) },
    })
  } catch {
    if (controller.signal.aborted) {
      if (parentSignal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
      if (timedOut) throw new Error('请求超时，请确认模型仍在加载或检查后端日志。')
    }
    throw new Error('无法连接 ruyi-serving，请确认 API 服务已启动。')
  } finally {
    globalThis.clearTimeout(timeoutId)
    parentSignal?.removeEventListener('abort', onParentAbort)
  }

  const payload = await parseJson(response)
  if (!response.ok) throw new Error(errorMessage(response.status, payload))
  return payload
}

export async function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return (await request('/health', { signal }, 10_000)) as HealthResponse
}

export async function getModels(signal?: AbortSignal): Promise<RuyiModel[]> {
  const payload = await request('/v1/models', { signal }, 10_000)
  if (Array.isArray(payload)) return payload as RuyiModel[]
  if (payload && typeof payload === 'object' && 'data' in payload) {
    const data = (payload as { data?: unknown }).data
    if (Array.isArray(data)) return data as RuyiModel[]
  }
  if (payload && typeof payload === 'object' && 'models' in payload) {
    const models = (payload as { models?: unknown }).models
    if (Array.isArray(models)) return models as RuyiModel[]
  }
  throw new Error('模型列表响应格式无法识别。')
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function outputText(output: unknown): string {
  if (!Array.isArray(output)) return ''
  const chunks: string[] = []
  for (const item of output) {
    if (!item || typeof item !== 'object') continue
    const content = (item as { content?: unknown }).content
    if (typeof content === 'string') {
      chunks.push(content)
      continue
    }
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      const value = (part as { type?: unknown; text?: unknown })
      if ((value.type === 'output_text' || value.type === undefined) && typeof value.text === 'string') {
        chunks.push(value.text)
      }
    }
  }
  return chunks.join('')
}

export function extractEngineResult(
  backend: BackendKind,
  modelId: string,
  payload: RawResponse,
): EngineResult {
  const usage = payload.usage
  const nativeMetrics = payload.execution_metrics
  const latencyMs = numberOrNull(nativeMetrics?.latency_ms)
  const completionTokens = numberOrNull(usage?.output_tokens)
  const calculatedTps =
    latencyMs !== null && latencyMs > 0 && completionTokens !== null
      ? completionTokens / (latencyMs / 1000)
      : null
  const metrics: InferenceMetrics = {
    latencyMs,
    timeToFirstTokenMs: numberOrNull(nativeMetrics?.time_to_first_token_ms),
    tokensPerSecond: numberOrNull(nativeMetrics?.tokens_per_second) ?? calculatedTps,
    promptTokens: numberOrNull(usage?.input_tokens),
    completionTokens,
    totalTokens: numberOrNull(usage?.total_tokens),
    metricsSource: nativeMetrics?.tokens_per_second !== undefined ? 'backend' : calculatedTps !== null ? 'frontend' : 'unavailable',
  }
  return {
    backend,
    modelId,
    text: outputText(payload.output),
    finishReason:
      payload.status === 'incomplete'
        ? 'incomplete'
        : payload.status === 'failed'
          ? 'error'
          : 'completed',
    metrics,
    status: payload.status === 'failed' ? 'error' : 'success',
    ...(payload.status === 'failed' ? { error: errorMessage(500, payload) } : {}),
  }
}

export async function runInference(
  backend: BackendKind,
  modelId: string,
  params: InferenceRequest,
  signal: AbortSignal,
): Promise<EngineResult> {
  const payload = (await request('/v1/responses', {
    method: 'POST',
    signal,
    body: JSON.stringify({
      model: modelId,
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: params.prompt }],
        },
      ],
      max_output_tokens: params.maxOutputTokens,
      temperature: params.temperature,
      backend_options: { seed: params.seed },
      stream: false,
    }),
  })) as RawResponse
  return extractEngineResult(backend, modelId, payload)
}
