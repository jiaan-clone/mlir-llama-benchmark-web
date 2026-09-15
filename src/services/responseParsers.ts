import { extractErrorMessage } from './httpClient'
import type { BackendKind, EngineResult, HealthResponse, InferenceMetrics } from '../types'

type RecordValue = Record<string, unknown>

function asRecord(value: unknown): RecordValue | null {
  return value && typeof value === 'object' ? value as RecordValue : null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

export function parseHealthResponse(payload: unknown): HealthResponse {
  const root = asRecord(payload)
  if (root) return root as HealthResponse
  if (typeof payload === 'string' && payload.trim()) return { status: payload.trim().toLowerCase() }
  return {}
}

function emptyMetrics(): InferenceMetrics {
  return {
    latencyMs: null,
    timeToFirstTokenMs: null,
    tokensPerSecond: null,
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    metricsSource: 'unavailable',
  }
}

function ruyiOutputText(output: unknown): string {
  if (!Array.isArray(output)) return ''
  const chunks: string[] = []
  for (const item of output) {
    const entry = asRecord(item)
    if (!entry) continue
    const content = entry.content
    if (typeof content === 'string') {
      chunks.push(content)
      continue
    }
    if (!Array.isArray(content)) continue
    for (const part of content) {
      const value = asRecord(part)
      if (!value) continue
      if ((value.type === 'output_text' || value.type === undefined) && typeof value.text === 'string') {
        chunks.push(value.text)
      }
    }
  }
  return chunks.join('')
}

export function parseRuyiResponse(
  backend: BackendKind,
  modelId: string,
  payload: unknown,
): EngineResult {
  const root = asRecord(payload) ?? {}
  const usage = asRecord(root.usage)
  const nativeMetrics = asRecord(asRecord(root.ruyi)?.execution_metrics) ?? asRecord(root.execution_metrics)
  const status = stringOrNull(root.status)
  const latencyMs = numberOrNull(nativeMetrics?.latency_ms)
  const completionTokens = numberOrNull(usage?.output_tokens)
  const backendTokensPerSecond = numberOrNull(nativeMetrics?.tokens_per_second)
  const calculatedTps =
    latencyMs !== null && latencyMs > 0 && completionTokens !== null
      ? completionTokens / (latencyMs / 1000)
      : null
  const metrics: InferenceMetrics = {
    latencyMs,
    timeToFirstTokenMs: numberOrNull(nativeMetrics?.time_to_first_token_ms),
    tokensPerSecond: backendTokensPerSecond ?? calculatedTps,
    promptTokens: numberOrNull(usage?.input_tokens),
    completionTokens,
    totalTokens: numberOrNull(usage?.total_tokens),
    metricsSource: backendTokensPerSecond !== null ? 'backend' : calculatedTps !== null ? 'frontend' : 'unavailable',
  }
  const failed = status === 'failed'
  return {
    backend,
    modelId,
    text: ruyiOutputText(root.output),
    finishReason: failed ? 'error' : status === 'incomplete' ? 'incomplete' : 'completed',
    metrics,
    status: failed ? 'error' : 'success',
    ...(failed ? { error: extractErrorMessage(payload, 500) } : {}),
  }
}

export const extractRuyiEngineResult = parseRuyiResponse

function llamaContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      const value = asRecord(part)
      return value && typeof value.text === 'string' ? value.text : ''
    })
    .join('')
}

/** Parse a non-streaming OpenAI-compatible llama-server response defensively. */
export function parseLlamaResponse(modelId: string, payload: unknown): EngineResult {
  const root = asRecord(payload) ?? {}
  if (root.error !== undefined) {
    return {
      backend: 'llama',
      modelId,
      text: '',
      finishReason: null,
      metrics: emptyMetrics(),
      status: 'error',
      error: extractErrorMessage(payload, 500),
    }
  }

  const choices = Array.isArray(root.choices) ? root.choices : []
  const firstChoice = asRecord(choices[0])
  const message = asRecord(firstChoice?.message)
  const usage = asRecord(root.usage)
  const timings = asRecord(root.timings)
  const promptTokens = numberOrNull(usage?.prompt_tokens) ?? numberOrNull(timings?.prompt_n)
  const completionTokens = numberOrNull(usage?.completion_tokens) ?? numberOrNull(timings?.predicted_n)
  const totalTokens = numberOrNull(usage?.total_tokens) ?? (
    promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null
  )
  const promptMs = numberOrNull(timings?.prompt_ms)
  const predictedMs = numberOrNull(timings?.predicted_ms)
  const latencyMs = numberOrNull(timings?.total_ms) ?? (
    promptMs !== null && predictedMs !== null ? promptMs + predictedMs : predictedMs
  )
  const backendTokensPerSecond = numberOrNull(timings?.predicted_per_second) ?? numberOrNull(timings?.prompt_per_second)
  const calculatedTps =
    backendTokensPerSecond === null && predictedMs !== null && predictedMs > 0 && completionTokens !== null
      ? completionTokens / (predictedMs / 1000)
      : null
  const metrics: InferenceMetrics = {
    latencyMs,
    timeToFirstTokenMs: null,
    tokensPerSecond: backendTokensPerSecond ?? calculatedTps,
    promptTokens,
    completionTokens,
    totalTokens,
    metricsSource: backendTokensPerSecond !== null ? 'backend' : calculatedTps !== null ? 'frontend' : 'unavailable',
  }

  return {
    backend: 'llama',
    modelId,
    text: llamaContentText(message?.content),
    finishReason: stringOrNull(firstChoice?.finish_reason),
    metrics,
    status: 'success',
  }
}

export const extractLlamaEngineResult = parseLlamaResponse

export type RuyiRawResponse = RecordValue
