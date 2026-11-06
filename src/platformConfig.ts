export const PLATFORM_BASE_PATH = '/benchmark/'

const PLATFORM_ENDPOINTS = {
  VITE_RUYI_API_BASE_URL: '/api/benchmark/buddy',
  VITE_LLAMA_SERVER_BASE_URL: '/api/benchmark/llama',
} as const

export function validatePlatformEnvironment(env: Record<string, string>): void {
  for (const [name, expected] of Object.entries(PLATFORM_ENDPOINTS)) {
    if (env[name] !== expected) {
      throw new Error(`${name} must be ${expected} for a platform build.`)
    }
  }
  for (const name of ['VITE_RUYI_API_KEY', 'VITE_LLAMA_SERVER_API_KEY']) {
    if (env[name]?.trim()) throw new Error(`${name} must be empty for a platform build.`)
  }
}

interface PlatformLocation {
  pathname: string
  search: string
  hash: string
}

export function platformReturnTo(location: PlatformLocation): string {
  return `${location.pathname}${location.search}${location.hash}`
}

export function platformLoginHref(returnTo: string): string {
  return `/auth/login?${new URLSearchParams({ returnTo }).toString()}`
}
