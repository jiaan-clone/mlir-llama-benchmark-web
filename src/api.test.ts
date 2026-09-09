import { describe, expect, it } from 'vitest'
import { extractEngineResult } from './api'

describe('response parsing', () => {
  it('joins output text parts and reads backend metrics', () => {
    const result = extractEngineResult('buddy', 'profile-buddy', {
      status: 'completed',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'Hello ' }] },
        { type: 'message', content: [{ type: 'output_text', text: 'world' }] },
      ],
      usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
      execution_metrics: { latency_ms: 250, time_to_first_token_ms: 40, tokens_per_second: 8 },
    })

    expect(result.text).toBe('Hello world')
    expect(result.metrics.promptTokens).toBe(4)
    expect(result.metrics.tokensPerSecond).toBe(8)
    expect(result.metrics.metricsSource).toBe('backend')
    expect(result.status).toBe('success')
  })

  it('handles failed responses without throwing', () => {
    const result = extractEngineResult('llama', 'profile-llama', {
      status: 'failed',
      error: { message: 'model unavailable' },
    })

    expect(result.status).toBe('error')
    expect(result.error).toBe('model unavailable')
    expect(result.metrics.tokensPerSecond).toBeNull()
  })

  it('accepts missing optional output and metrics fields', () => {
    const result = extractEngineResult('llama', 'profile-llama', { status: 'completed' })
    expect(result.text).toBe('')
    expect(result.metrics.totalTokens).toBeNull()
    expect(result.finishReason).toBe('completed')
  })
})
