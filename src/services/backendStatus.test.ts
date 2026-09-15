import { describe, expect, it } from 'vitest'
import { availabilityFor, initialBackendStatus, isHealthy, loadBackendStatus, modelIsReady } from './backendStatus'

describe('backend status coordination helpers', () => {
  it('recognizes independent health payloads', () => {
    expect(isHealthy({ status: 'ready' })).toBe(true)
    expect(isHealthy({ status: 'starting' })).toBe(false)
  })

  it('keeps model readiness scoped to one backend', () => {
    const status = { ...initialBackendStatus(), healthStatus: 'ready' as const, modelsLoaded: true, models: new Set(['alias']) }
    expect(modelIsReady(status, 'alias')).toBe(true)
    expect(modelIsReady(status, 'other')).toBe(false)
    expect(availabilityFor(status, 'idle', 'alias')).toBe('ready')
    expect(availabilityFor({ ...status, healthStatus: 'unavailable' }, 'idle', 'alias')).toBe('unavailable')
    expect(availabilityFor({ ...initialBackendStatus(), healthStatus: 'unavailable' }, 'idle', 'alias')).toBe('unavailable')
    expect(availabilityFor(status, 'running', 'alias')).toBe('running')
  })

  it('retains a healthy side when the other side fails', async () => {
    const healthy = await loadBackendStatus({
      getHealth: async () => ({ status: 'ok' }),
      getModels: async () => [{ id: 'buddy' }],
      runInference: async () => { throw new Error('not used') },
    }, 'ruyi-serving')
    const failed = await loadBackendStatus({
      getHealth: async () => { throw new Error('offline') },
      getModels: async () => { throw new Error('offline') },
      runInference: async () => { throw new Error('not used') },
    }, 'llama-server')
    expect(healthy.healthStatus).toBe('ready')
    expect(healthy.models.has('buddy')).toBe(true)
    expect(failed.healthStatus).toBe('unavailable')
    expect(failed.modelsLoaded).toBe(false)
  })
})
