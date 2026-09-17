import { describe, expect, it } from 'vitest'
import { formatNumber, safeSpeedup, speedupForResults, validMeasurement, validTokenCount, withWallClockFallback } from './metrics'
import type { EngineResult } from './types'

describe('benchmark metrics', () => {
  it('calculates buddy speedup over llama', () => {
    expect(safeSpeedup(30, 20)).toBe(1.5)
  })

  it('does not emit invalid ratios', () => {
    expect(safeSpeedup(null, 20)).toBeNull()
    expect(safeSpeedup(20, 0)).toBeNull()
    expect(safeSpeedup(0, 20)).toBeNull()
    expect(safeSpeedup(1e308, 1e-308)).toBeNull()
    expect(safeSpeedup(1e-308, 1e308)).toBeNull()
  })

  it('validates token counts and measurements without turning missing or zero into each other', () => {
    for (const value of [-1, NaN, Infinity, '3', null]) {
      expect(validMeasurement(value)).toBeNull()
      expect(validTokenCount(value)).toBeNull()
    }
    expect(validTokenCount(1.5)).toBeNull()
    expect(validTokenCount(0)).toBe(0)
    expect(validMeasurement(0)).toBe(0)
  })

  it('keeps backend TPS while using browser latency and first text fallbacks', () => {
    const result: EngineResult = { backend: 'buddy', modelId: 'm', text: 'ok', finishReason: 'completed', status: 'success',
      metrics: { latencyMs: null, timeToFirstTokenMs: null, tokensPerSecond: 7,
        promptTokens: null, completionTokens: 3, totalTokens: null, metricsSource: 'backend' } }
    expect(withWallClockFallback(result, 250, 35).metrics).toMatchObject({ latencyMs: 250, timeToFirstTokenMs: 35, tokensPerSecond: 7, metricsSource: 'backend' })
    const zero = { ...result, metrics: { ...result.metrics, latencyMs: 0, timeToFirstTokenMs: 0, tokensPerSecond: 0 } }
    expect(withWallClockFallback(zero, 250, 35).metrics).toMatchObject({ latencyMs: 0, timeToFirstTokenMs: 0, tokensPerSecond: 0 })
    expect(withWallClockFallback({ ...result, metrics: { ...result.metrics, tokensPerSecond: null } }, 250).metrics)
      .toMatchObject({ tokensPerSecond: 12, metricsSource: 'frontend' })
    expect(withWallClockFallback({ ...result, metrics: { ...result.metrics, completionTokens: null, tokensPerSecond: null } }, 250).metrics.tokensPerSecond).toBeNull()
    expect(withWallClockFallback({ ...result, metrics: { ...result.metrics, tokensPerSecond: null } }, 1e-320).metrics.tokensPerSecond).toBeNull()
    expect(speedupForResults({ ...result, status: 'cancelled' }, { ...result, backend: 'llama' })).toBeNull()
    expect(speedupForResults({ ...result, status: 'error' }, { ...result, backend: 'llama' })).toBeNull()
  })

  it('formats unavailable values safely', () => {
    expect(formatNumber(null)).toBe('-')
    expect(formatNumber(12.345, 2)).toBe('12.35')
  })
})
