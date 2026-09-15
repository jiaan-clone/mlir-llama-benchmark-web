import { ruyiConfig } from '../config'
import type { BackendClient, BackendConfig, EngineResult, HealthResponse, InferenceRequest, ModelInfo } from '../types'
import { requestJson, withServiceError } from './httpClient'
import { parseHealthResponse, parseRuyiResponse } from './responseParsers'

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
        body: JSON.stringify({
          model: modelId,
          input: [{ role: 'user', content: [{ type: 'input_text', text: params.prompt }] }],
          max_output_tokens: params.maxOutputTokens,
          temperature: params.temperature,
          ruyi: { backend_options: { seed: params.seed } },
          stream: false,
        }),
      })
      return parseRuyiResponse('buddy', modelId, payload)
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
