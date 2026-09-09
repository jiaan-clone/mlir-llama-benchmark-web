import type { ModelProfile } from './types'

const defaultProfile: ModelProfile = {
  id: 'deepseek-r1-1.5b',
  name: 'DeepSeek R1-Distill-Qwen-1.5B',
  buddyModelId: 'deepseek-r1-buddy',
  llamaModelId: 'deepseek-r1-llama',
}

function parseProfiles(raw: string | undefined): ModelProfile[] {
  if (!raw) return [defaultProfile]

  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return [defaultProfile]

    const profiles = parsed.filter((item): item is ModelProfile => {
      if (!item || typeof item !== 'object') return false
      const value = item as Record<string, unknown>
      return (
        typeof value.id === 'string' &&
        typeof value.name === 'string' &&
        typeof value.buddyModelId === 'string' &&
        typeof value.llamaModelId === 'string'
      )
    })
    return profiles.length > 0 ? profiles : [defaultProfile]
  } catch {
    return [defaultProfile]
  }
}

export const apiBaseUrl = (
  import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8000'
).replace(/\/$/, '')

export const apiKey = import.meta.env.VITE_RUYI_API_KEY || ''
export const defaultProfileId =
  import.meta.env.VITE_DEFAULT_PROFILE_ID || defaultProfile.id
export const modelProfiles = parseProfiles(
  import.meta.env.VITE_MODEL_PROFILES_JSON,
)
