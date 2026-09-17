import type { EngineResult } from './types'

export function validMeasurement(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

export function validTokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/** Keep backend throughput even when other measurements use browser fallbacks. */
export function withWallClockFallback(result: EngineResult, elapsedMs: number, firstTextMs: number | null = null): EngineResult {
  if (result.status !== 'success') return result
  const latencyMs = validMeasurement(result.metrics.latencyMs) ?? validMeasurement(elapsedMs)
  const timeToFirstTokenMs = validMeasurement(result.metrics.timeToFirstTokenMs) ?? validMeasurement(firstTextMs)
  const nativeTps = validMeasurement(result.metrics.tokensPerSecond)
  const completionTokens = validTokenCount(result.metrics.completionTokens)
  const calculatedTps = nativeTps === null && completionTokens !== null && latencyMs !== null && latencyMs > 0
    ? validMeasurement(completionTokens / (latencyMs / 1000)) : null
  return {
    ...result,
    metrics: {
      ...result.metrics,
      latencyMs,
      timeToFirstTokenMs,
      tokensPerSecond: nativeTps ?? calculatedTps,
      metricsSource: nativeTps !== null ? result.metrics.metricsSource : calculatedTps !== null ? 'frontend' : 'unavailable',
    },
  }
}

export function speedupForResults(buddy: EngineResult | null, llama: EngineResult | null): number | null {
  return safeSpeedup(buddy?.status === 'success' ? buddy.metrics.tokensPerSecond : null,
    llama?.status === 'success' ? llama.metrics.tokensPerSecond : null)
}

export function safeSpeedup(
  buddyTokensPerSecond: number | null,
  llamaTokensPerSecond: number | null,
): number | null {
  if (
    buddyTokensPerSecond === null ||
    llamaTokensPerSecond === null ||
    !Number.isFinite(buddyTokensPerSecond) ||
    !Number.isFinite(llamaTokensPerSecond) ||
    buddyTokensPerSecond <= 0 ||
    llamaTokensPerSecond <= 0
  ) {
    return null
  }
  const ratio = buddyTokensPerSecond / llamaTokensPerSecond
  return Number.isFinite(ratio) && ratio > 0 && (ratio >= 1 || Number.isFinite(1 / ratio)) ? ratio : null
}

export function formatNumber(value: number | null, digits = 1): string {
  return value === null || !Number.isFinite(value) ? '-' : value.toFixed(digits)
}

export function formatMetric(value: number | null, unit: string, digits = 1): string {
  const formatted = formatNumber(value, digits)
  return formatted === '-' ? formatted : `${formatted} ${unit}`
}
