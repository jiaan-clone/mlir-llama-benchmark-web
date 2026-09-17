import { ruyiConfig } from '../config'
import type { BackendClient, BackendConfig, EngineResult, HealthResponse, InferenceRequest, ModelInfo, StreamUpdateHandler } from '../types'
import { requestJson, withServiceError } from './httpClient'
import { parseHealthResponse, parseRuyiResponse } from './responseParsers'
import { ruyiRequestBody, streamRuyiInference } from './ruyiStream'

const serviceName = 'ruyi-serving'

export function parseRuyiModels(payload: unknown): ModelInfo[] {
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null
  const source = Array.isArray(payload) ? payload : Array.isArray(root?.data) ? root.data : Array.isArray(root?.models) ? root.models : null
  if (!source) throw new Error('ruyi-serving 模型列表响应格式无法识别。')
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

export function createRuyiClient(config: BackendConfig = ruyiConfig): BackendClient {
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
      return parseRuyiModels(await request('/v1/models', { signal }, 10_000))
    },

    async runInference(modelId: string, params: InferenceRequest, signal: AbortSignal): Promise<EngineResult> {
      const payload = await request('/v1/responses', {
        method: 'POST',
        signal,
        body: ruyiRequestBody(modelId, params, false),
      })
      return parseRuyiResponse('buddy', modelId, payload)
    },

    streamInference(modelId: string, params: InferenceRequest, signal: AbortSignal, onUpdate: StreamUpdateHandler): Promise<EngineResult> {
      return streamRuyiInference(modelId, params, signal, onUpdate, config)
    },
  }
}

export const ruyiClient = createRuyiClient()

export const getHealth = (signal?: AbortSignal) => ruyiClient.getHealth(signal)
export const getModels = (signal?: AbortSignal) => ruyiClient.getModels(signal)
export const getRuyiHealth = getHealth
export const getRuyiModels = getModels
export const runRuyiInference = (
  modelId: string,
  params: InferenceRequest,
  signal: AbortSignal,
) => ruyiClient.runInference(modelId, params, signal)
export { streamRuyiInference } from './ruyiStream'
