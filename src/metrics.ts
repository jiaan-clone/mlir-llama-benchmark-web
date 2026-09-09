export function safeSpeedup(
  buddyTokensPerSecond: number | null,
  llamaTokensPerSecond: number | null,
): number | null {
  if (
    buddyTokensPerSecond === null ||
    llamaTokensPerSecond === null ||
    !Number.isFinite(buddyTokensPerSecond) ||
    !Number.isFinite(llamaTokensPerSecond) ||
    buddyTokensPerSecond < 0 ||
    llamaTokensPerSecond <= 0
  ) {
    return null
  }
  return buddyTokensPerSecond / llamaTokensPerSecond
}

export function formatNumber(value: number | null, digits = 1): string {
  return value === null || !Number.isFinite(value) ? '-' : value.toFixed(digits)
}

export function formatMetric(value: number | null, unit: string, digits = 1): string {
  const formatted = formatNumber(value, digits)
  return formatted === '-' ? formatted : `${formatted} ${unit}`
}
