export type BackendKind = 'buddy' | 'llama'

export interface ModelProfile {
  id: string
  name: string
  buddyModelId: string
  llamaModelId: string
}

export interface RuyiModel {
  id: string
  owned_by?: string
  ready?: boolean
}

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
