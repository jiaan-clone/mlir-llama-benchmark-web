/**
 * Compatibility facade for consumers that still import the original API module.
 * New code should use services/backendClients.ts and the dedicated clients.
 */
import { ruyiClient } from './services/ruyiClient'
import { parseRuyiResponse } from './services/responseParsers'
import type { BackendKind, EngineResult, InferenceRequest } from './types'

export const getHealth = (signal?: AbortSignal) => ruyiClient.getHealth(signal)
export const getModels = (signal?: AbortSignal) => ruyiClient.getModels(signal)

export async function runInference(
  backend: BackendKind,
  modelId: string,
  params: InferenceRequest,
  signal: AbortSignal,
): Promise<EngineResult> {
  const result = await ruyiClient.runInference(modelId, params, signal)
  return { ...result, backend }
}

/** Preserve the historical parser export used by existing tests/integrations. */
export function extractEngineResult(
  backend: BackendKind,
  modelId: string,
  payload: unknown,
): EngineResult {
  return parseRuyiResponse(backend, modelId, payload)
}
