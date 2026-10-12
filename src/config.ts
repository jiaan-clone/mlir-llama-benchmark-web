import type { BackendConfig, ModelProfile } from './types'

const defaultProfile: ModelProfile = {
  id: 'deepseek-r1-1.5b',
  name: 'DeepSeek R1-Distill-Qwen-1.5B',
  buddyModelId: 'deepseek-r1-buddy',
  llamaModelId: 'deepseek-r1-llama',
}

/** Parse user supplied profiles without allowing malformed JSON into the UI. */
export function parseModelProfiles(raw: string | undefined): ModelProfile[] {
  if (!raw?.trim()) return [defaultProfile]

  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return [defaultProfile]

    const profiles = parsed.flatMap((item): ModelProfile[] => {
      if (!item || typeof item !== 'object') return []
      const value = item as Record<string, unknown>
      if (!(
        typeof value.id === 'string' &&
        typeof value.name === 'string' &&
        typeof value.buddyModelId === 'string' &&
        typeof value.llamaModelId === 'string'
      )) return []
      const profile: ModelProfile = {
        id: value.id,
        name: value.name,
        buddyModelId: value.buddyModelId,
        llamaModelId: value.llamaModelId,
      }
      if (typeof value.llamaServerModelId === 'string' && value.llamaServerModelId.trim()) {
        profile.llamaServerModelId = value.llamaServerModelId
      }
      return [profile]
    })
    return profiles.length > 0 ? profiles : [defaultProfile]
  } catch {
    return [defaultProfile]
  }
}

function cleanBaseUrl(value: string | undefined, fallback: string): string {
  return (value?.trim() || fallback).replace(/\/$/, '')
}

const env = import.meta.env

export function parseInferenceTimeoutMs(value: string | undefined): number {
  const timeout = Number(value)
  return Number.isInteger(timeout) && timeout > 0 && timeout <= 2_147_483_647 ? timeout : 120_000
}

/** Configuration for the gateway that fronts Buddy-MLIR. */
export const ruyiConfig: BackendConfig = {
  baseUrl: cleanBaseUrl(
    env.VITE_RUYI_API_BASE_URL || env.VITE_API_BASE_URL,
    'http://127.0.0.1:8000',
  ),
  apiKey: env.VITE_RUYI_API_KEY?.trim() || '',
  inferenceTimeoutMs: parseInferenceTimeoutMs(env.VITE_RUYI_INFERENCE_TIMEOUT_MS),
}

/** Configuration for a standalone llama-server OpenAI-compatible endpoint. */
export const llamaServerConfig: BackendConfig = {
  baseUrl: cleanBaseUrl(env.VITE_LLAMA_SERVER_BASE_URL, 'http://127.0.0.1:8080'),
  apiKey: env.VITE_LLAMA_SERVER_API_KEY?.trim() || '',
  inferenceTimeoutMs: parseInferenceTimeoutMs(env.VITE_LLAMA_INFERENCE_TIMEOUT_MS),
}

/** Backwards-compatible facade exports used by older integrations. */
export const apiBaseUrl = ruyiConfig.baseUrl
export const apiKey = ruyiConfig.apiKey
export const defaultProfileId = env.VITE_DEFAULT_PROFILE_ID?.trim() || defaultProfile.id
export const modelProfiles = parseModelProfiles(env.VITE_MODEL_PROFILES_JSON)

export { defaultProfile }
