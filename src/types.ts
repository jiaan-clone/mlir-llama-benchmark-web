export type BackendKind = 'buddy' | 'llama'
export type BackendAvailability = 'checking' | 'ready' | 'unavailable' | 'running'

export interface BackendStatus {
  healthStatus: Exclude<BackendAvailability, 'running'>
  healthError: string
  models: Set<string>
  modelsLoaded: boolean
  modelsError: string
}

export interface BackendConfig {
  baseUrl: string
  apiKey: string
}

export interface ModelProfile {
  id: string
  name: string
  buddyModelId: string
  llamaModelId: string
  /** Optional llama-server alias; older profiles use llamaModelId. */
  llamaServerModelId?: string
}

export interface ModelInfo {
  id: string
  owned_by?: string
  ready?: boolean
}

export type RuyiModel = ModelInfo
export type LlamaModel = ModelInfo

export interface HealthResponse {
  healthy?: boolean
  status?: string
  message?: string
  status_message?: string
  [key: string]: unknown
}

export interface InferenceRequest {
  prompt: string
  maxOutputTokens: number
  temperature: number
  seed: number
}

export interface EngineStreamUpdate {
  delta: string
  text: string
  timeToFirstTokenMs: number | null
  finishReason: string | null
}

export type LlamaStreamUpdate = EngineStreamUpdate
export type StreamUpdateHandler = (update: EngineStreamUpdate) => void

export interface InferenceMetrics {
  latencyMs: number | null
  timeToFirstTokenMs: number | null
  tokensPerSecond: number | null
  promptTokens: number | null
  completionTokens: number | null
  totalTokens: number | null
  metricsSource: 'backend' | 'frontend' | 'unavailable'
}

export interface EngineResult {
  backend: BackendKind
  modelId: string
  text: string
  finishReason: string | null
  metrics: InferenceMetrics
  status: 'success' | 'error' | 'cancelled'
  error?: string
}

export interface BackendClient {
  getHealth(signal?: AbortSignal): Promise<HealthResponse>
  getModels(signal?: AbortSignal): Promise<ModelInfo[]>
  runInference(
    modelId: string,
    params: InferenceRequest,
    signal: AbortSignal,
  ): Promise<EngineResult>
  streamInference?: (
    modelId: string,
    params: InferenceRequest,
    signal: AbortSignal,
    onUpdate: StreamUpdateHandler,
  ) => Promise<EngineResult>
}
