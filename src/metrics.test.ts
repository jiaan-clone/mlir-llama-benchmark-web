import { describe, expect, it } from 'vitest'
import { formatNumber, safeSpeedup } from './metrics'

describe('benchmark metrics', () => {
  it('calculates buddy speedup over llama', () => {
    expect(safeSpeedup(30, 20)).toBe(1.5)
  })

  it('does not emit invalid ratios', () => {
    expect(safeSpeedup(null, 20)).toBeNull()
    expect(safeSpeedup(20, 0)).toBeNull()
  })

  it('formats unavailable values safely', () => {
    expect(formatNumber(null)).toBe('-')
    expect(formatNumber(12.345, 2)).toBe('12.35')
  })
})
