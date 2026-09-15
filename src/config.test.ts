import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseModelProfiles } from './config'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('configuration parsing', () => {
  it('supports the optional llama-server model alias', () => {
    const [profile] = parseModelProfiles(JSON.stringify([{
      id: 'demo',
      name: 'Demo',
      buddyModelId: 'buddy-id',
      llamaModelId: 'legacy-id',
      llamaServerModelId: 'server-alias',
    }]))
    expect(profile).toMatchObject({ llamaModelId: 'legacy-id', llamaServerModelId: 'server-alias' })
  })

  it('falls back for empty, malformed, and structurally invalid profiles', () => {
    expect(parseModelProfiles(undefined)[0].id).toBe('deepseek-r1-1.5b')
    expect(parseModelProfiles('   ')[0].id).toBe('deepseek-r1-1.5b')
    expect(parseModelProfiles('{not-json}')[0].id).toBe('deepseek-r1-1.5b')
    expect(parseModelProfiles(JSON.stringify([{ id: 'missing-fields' }]))[0].id).toBe('deepseek-r1-1.5b')
  })

  it('ignores an empty optional alias and preserves legacy fields', () => {
    const [profile] = parseModelProfiles(JSON.stringify([{
      id: 'demo', name: 'Demo', buddyModelId: 'b', llamaModelId: 'l', llamaServerModelId: '  ',
    }]))
    expect(profile.llamaModelId).toBe('l')
    expect(profile.llamaServerModelId).toBeUndefined()
  })

  it('reads new service variables and falls back to the legacy API variable', async () => {
    vi.stubEnv('VITE_RUYI_API_BASE_URL', 'http://new-ruyi.test/')
    vi.stubEnv('VITE_API_BASE_URL', 'http://legacy.test/')
    vi.stubEnv('VITE_LLAMA_SERVER_BASE_URL', 'http://llama.test/')
    vi.stubEnv('VITE_RUYI_API_KEY', 'ruyi-key')
    vi.stubEnv('VITE_LLAMA_SERVER_API_KEY', 'llama-key')
    vi.resetModules()
    const configured = await import('./config')
    expect(configured.ruyiConfig).toEqual({ baseUrl: 'http://new-ruyi.test', apiKey: 'ruyi-key' })
    expect(configured.llamaServerConfig).toEqual({ baseUrl: 'http://llama.test', apiKey: 'llama-key' })

    vi.stubEnv('VITE_RUYI_API_BASE_URL', '')
    vi.resetModules()
    const legacy = await import('./config')
    expect(legacy.ruyiConfig.baseUrl).toBe('http://legacy.test')
  })
})
