import { llamaServerConfig } from '../config'
import type { BackendClient, BackendConfig, EngineResult, HealthResponse, InferenceRequest, ModelInfo, ModelProfile } from '../types'
import { requestJson, withServiceError } from './httpClient'
import { parseHealthResponse, parseLlamaResponse } from './responseParsers'

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
