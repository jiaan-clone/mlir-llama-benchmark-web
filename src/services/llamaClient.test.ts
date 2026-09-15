import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLlamaClient, resolveLlamaModelId } from './llamaClient'
import { parseLlamaResponse } from './responseParsers'

afterEach(() => vi.restoreAllMocks())

describe('llama-server client', () => {
  it('prefers the explicit server alias and falls back to legacy modelId', () => {
    expect(resolveLlamaModelId({ llamaModelId: 'legacy', llamaServerModelId: 'alias' })).toBe('alias')
    expect(resolveLlamaModelId({ llamaModelId: 'legacy' })).toBe('legacy')
  })

  it('uses the OpenAI chat completion contract and maps metrics', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'alias' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        model: 'alias',
        choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        timings: { prompt_per_second: 100, predicted_per_second: 8, prompt_ms: 10, predicted_ms: 250 },
      }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = createLlamaClient({ baseUrl: 'http://llama.test/', apiKey: 'key' })

    await expect(client.getHealth()).resolves.toMatchObject({ status: 'ok' })
    await expect(client.getModels()).resolves.toEqual([{ id: 'alias' }])
    const result = await client.runInference('alias', {
      prompt: 'Say hello', maxOutputTokens: 32, temperature: 0.2, seed: 7,
    }, new AbortController().signal)

    expect(result.text).toBe('hello')
    expect(result.metrics.tokensPerSecond).toBe(8)
    expect(result.metrics.latencyMs).toBe(260)
    expect(result.finishReason).toBe('stop')
    const request = fetchMock.mock.calls[2][1] as RequestInit
    expect(fetchMock.mock.calls[2][0]).toBe('http://llama.test/v1/chat/completions')
    expect(JSON.parse(String(request.body))).toMatchObject({
      model: 'alias', max_tokens: 32, temperature: 0.2, seed: 7, stream: false,
      messages: [{ role: 'user', content: 'Say hello' }],
    })
    expect(new Headers(request.headers).get('Authorization')).toBe('Bearer key')
  })
})

describe('llama response parser', () => {
  it('handles empty choices and invalid optional numbers safely', () => {
    const result = parseLlamaResponse('alias', {
      choices: [],
      usage: { prompt_tokens: 'bad', completion_tokens: Infinity },
      timings: { predicted_per_second: 'bad' },
    })
    expect(result.status).toBe('success')
    expect(result.text).toBe('')
    expect(result.finishReason).toBeNull()
    expect(result.metrics.promptTokens).toBeNull()
    expect(result.metrics.tokensPerSecond).toBeNull()
  })

  it('supports OpenAI error strings and objects without throwing', () => {
    expect(parseLlamaResponse('alias', { error: 'model unavailable' })).toMatchObject({
      status: 'error', error: 'model unavailable', backend: 'llama',
    })
    expect(parseLlamaResponse('alias', { error: { message: 'bad request', code: 'invalid' } })).toMatchObject({
      status: 'error', error: 'bad request',
    })
  })

  it('reads content parts and falls back to timing-derived usage', () => {
    const result = parseLlamaResponse('alias', {
      choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }, finish_reason: 'length' }],
      timings: { prompt_n: 4, predicted_n: 6, predicted_ms: 500 },
    })
    expect(result.text).toBe('ab')
    expect(result.metrics.promptTokens).toBe(4)
    expect(result.metrics.completionTokens).toBe(6)
    expect(result.metrics.totalTokens).toBe(10)
    expect(result.metrics.tokensPerSecond).toBe(12)
    expect(result.metrics.metricsSource).toBe('frontend')
  })

  it('uses prompt timing as a backend speed fallback when prediction timing is absent', () => {
    const result = parseLlamaResponse('alias', { choices: [], timings: { prompt_per_second: 42 } })
    expect(result.metrics.tokensPerSecond).toBe(42)
    expect(result.metrics.metricsSource).toBe('backend')
  })
})
