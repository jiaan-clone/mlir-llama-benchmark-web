import { llamaServerConfig } from '../config'
import { withWallClockFallback } from '../metrics'
import type { BackendClient, BackendConfig, EngineResult, HealthResponse, InferenceRequest, EngineStreamUpdate, ModelInfo, ModelProfile, StreamUpdateHandler } from '../types'
import { HttpClientError, requestJson, requestStream, withServiceError } from './httpClient'
import { readSseStream } from './readSseStream'
import { parseHealthResponse, parseLlamaResponse } from './responseParsers'
import { parseLlamaSseEvent } from './llamaStreamParser'

const serviceName = 'llama-server'

export function resolveLlamaModelId(profile: Pick<ModelProfile, 'llamaModelId' | 'llamaServerModelId'>): string {
  return profile.llamaServerModelId ?? profile.llamaModelId
}

export function parseLlamaModels(payload: unknown): ModelInfo[] {
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null
  const source = Array.isArray(payload) ? payload : Array.isArray(root?.data) ? root.data : null
  if (!source) throw new Error('llama-server 模型列表响应格式无法识别。')
  return source.flatMap((item): ModelInfo[] => {
    if (!item || typeof item !== 'object') return []
    const value = item as Record<string, unknown>
    if (typeof value.id !== 'string' || !value.id.trim()) return []
    return [{
      id: value.id,
      ...(typeof value.owned_by === 'string' ? { owned_by: value.owned_by } : {}),
      ...(typeof value.ready === 'boolean' ? { ready: value.ready } : {}),
    }]
  })
}

function streamResultPayload(
  text: string,
  finishReason: string | null,
  usage: Record<string, unknown> | null,
  timings: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    choices: [{ message: { content: text }, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
    ...(timings ? { timings } : {}),
  }
}

/** Read llama-server SSE output without coupling protocol parsing to React state. */
export async function streamLlamaInference(
  modelId: string,
  params: InferenceRequest,
  signal: AbortSignal,
  onUpdate: StreamUpdateHandler = () => undefined,
  config: BackendConfig = llamaServerConfig,
): Promise<EngineResult> {
  const startedAt = performance.now()
  let stream
  try {
    stream = await requestStream({
      ...config,
      path: '/v1/chat/completions',
      timeoutMs: 120_000,
      init: {
        method: 'POST',
        signal,
        headers: { Accept: 'text/event-stream' },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: params.prompt }],
          max_tokens: params.maxOutputTokens,
          temperature: params.temperature,
          seed: params.seed,
          stream: true,
        }),
      },
    })
  } catch (error) {
    throw withServiceError(error, serviceName)
  }

  let text = ''
  let finishReason: string | null = null
  let firstTokenMs: number | null = null
  let usage: Record<string, unknown> | null = null
  let timings: Record<string, unknown> | null = null
  let done = false
  const consumeEvent = (data: string): void => {
    const event = parseLlamaSseEvent(data)
    if (!event) return
    if (event.kind === 'done') {
      done = true
      return
    }
    if (event.delta) {
      text += event.delta
      if (firstTokenMs === null) firstTokenMs = performance.now() - startedAt
    }
    finishReason = event.finishReason ?? finishReason
    usage = event.usage ?? usage
    timings = event.timings ?? timings
    const update: EngineStreamUpdate = {
      delta: event.delta,
      text,
      timeToFirstTokenMs: firstTokenMs,
      finishReason,
    }
    onUpdate(update)
  }

  try {
    await readSseStream(stream.response, stream.signal, ({ data }) => {
      consumeEvent(data)
      return done
    })
    if (!done) throw new Error('llama-server 响应流中断：未收到 [DONE]。')
    const elapsedMs = performance.now() - startedAt
    const parsed = parseLlamaResponse(modelId, streamResultPayload(text, finishReason, usage, timings))
    return withWallClockFallback(parsed, elapsedMs, firstTokenMs)
  } catch (error) {
    if (stream.didTimeout()) {
      throw withServiceError(new HttpClientError('请求超时。', 'timeout'), serviceName)
    }
    throw withServiceError(error, serviceName)
  } finally {
    stream.cleanup()
  }
}

export function createLlamaClient(config: BackendConfig = llamaServerConfig): BackendClient {
  const request = async <T>(path: string, init: RequestInit = {}, timeoutMs = 120_000): Promise<T | null> => {
    try {
      return await requestJson<T>({ ...config, path, init, timeoutMs })
    } catch (error) {
      throw withServiceError(error, serviceName)
    }
  }

  return {
    async getHealth(signal?: AbortSignal): Promise<HealthResponse> {
      return parseHealthResponse(await request('/health', { signal }, 10_000))
    },

    async getModels(signal?: AbortSignal): Promise<ModelInfo[]> {
      return parseLlamaModels(await request('/v1/models', { signal }, 10_000))
    },

    async runInference(modelId: string, params: InferenceRequest, signal: AbortSignal): Promise<EngineResult> {
      const payload = await request('/v1/chat/completions', {
        method: 'POST',
        signal,
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: params.prompt }],
          max_tokens: params.maxOutputTokens,
          temperature: params.temperature,
          seed: params.seed,
          stream: false,
        }),
      })
      return parseLlamaResponse(modelId, payload)
    },

    streamInference(modelId: string, params: InferenceRequest, signal: AbortSignal, onUpdate: StreamUpdateHandler): Promise<EngineResult> {
      return streamLlamaInference(modelId, params, signal, onUpdate, config)
    },
  }
}

export const llamaClient = createLlamaClient()

export const getLlamaHealth = (signal?: AbortSignal) => llamaClient.getHealth(signal)
export const getLlamaModels = (signal?: AbortSignal) => llamaClient.getModels(signal)
export const getHealth = getLlamaHealth
export const getModels = getLlamaModels
export const runLlamaInference = (
  modelId: string,
  params: InferenceRequest,
  signal: AbortSignal,
) => llamaClient.runInference(modelId, params, signal)
export const runInference = runLlamaInference
