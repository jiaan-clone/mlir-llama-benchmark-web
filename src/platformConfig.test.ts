import { describe, expect, it } from 'vitest'
import { platformLoginHref, platformReturnTo, validatePlatformEnvironment } from './platformConfig'

describe('platform integration configuration', () => {
  const valid = {
    VITE_RUYI_API_BASE_URL: '/api/benchmark/buddy',
    VITE_LLAMA_SERVER_BASE_URL: '/api/benchmark/llama',
    VITE_RUYI_API_KEY: '',
    VITE_LLAMA_SERVER_API_KEY: '',
  }

  it('accepts only same-origin gateway paths without browser API keys', () => {
    expect(() => validatePlatformEnvironment(valid)).not.toThrow()
    expect(() => validatePlatformEnvironment({ ...valid, VITE_RUYI_API_KEY: 'secret' })).toThrow('must be empty')
    expect(() => validatePlatformEnvironment({ ...valid, VITE_LLAMA_SERVER_BASE_URL: 'http://127.0.0.1:8080' })).toThrow('/api/benchmark/llama')
  })

  it('builds a same-site login link that preserves the current page', () => {
    const returnTo = platformReturnTo({ pathname: '/benchmark/', search: '?model=test', hash: '#results' })
    expect(returnTo).toBe('/benchmark/?model=test#results')
    expect(platformLoginHref(returnTo)).toBe('/auth/login?returnTo=%2Fbenchmark%2F%3Fmodel%3Dtest%23results')
  })
})
