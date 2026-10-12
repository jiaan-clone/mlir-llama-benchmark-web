import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLlamaClient, resolveLlamaModelId, streamLlamaInference } from './llamaClient'
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

  it('uses the configured timeout for non-stream inference', async () => {
    vi.useFakeTimers()
    try {
      let requestSignal: AbortSignal | undefined
      vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
        requestSignal = init.signal as AbortSignal
        requestSignal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })))
      const client = createLlamaClient({ baseUrl: 'http://llama.test', apiKey: '', inferenceTimeoutMs: 1800000 })
      const pending = client.runInference('alias', {
        prompt: 'hello', maxOutputTokens: 12, temperature: 0, seed: 42,
      }, new AbortController().signal)
      const expectation = expect(pending).rejects.toThrow('llama-server 请求超时')
      await vi.advanceTimersByTimeAsync(120000)
      expect(requestSignal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1680000)
      await expectation
      expect(requestSignal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it('streams UTF-8 chunks, reports first token time, and keeps the non-stream result shape', async () => {
    const payload = [
      `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: '你' }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: '好' }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }, timings: { predicted_per_second: 10, total_ms: 300 } })}\n\n`,
      'data: [DONE]\n\n',
    ].join('')
    const encoded = new TextEncoder().encode(payload)
    const splitAt = encoded.findIndex((byte, index) => byte >= 0x80 && index > 0) + 1
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, splitAt))
        controller.enqueue(encoded.slice(splitAt))
        controller.close()
      },
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })))

    const updates: string[] = []
    const result = await streamLlamaInference('alias', {
      prompt: '你好', maxOutputTokens: 32, temperature: 0, seed: 42,
    }, new AbortController().signal, (update) => updates.push(update.text), {
      baseUrl: 'http://llama.test', apiKey: '',
    })

    expect(updates).toEqual(['', '你', '你好', '你好'])
    expect(result.text).toBe('你好')
    expect(result.metrics.timeToFirstTokenMs).not.toBeNull()
    expect(result.metrics.latencyMs).toBe(300)
    expect(result.metrics.tokensPerSecond).toBe(10)
    expect(result.metrics.metricsSource).toBe('backend')
    expect(result.finishReason).toBe('stop')
    const request = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit
    expect(JSON.parse(String(request.body))).toMatchObject({ stream: true, max_tokens: 32 })
  })

  it('propagates stream cancellation as AbortError and releases the reader', async () => {
    const controller = new AbortController()
    let bodyController: ReadableStreamDefaultController<Uint8Array> | null = null
    const body = new ReadableStream<Uint8Array>({
      start(nextController) {
        bodyController = nextController
      },
    })
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => bodyController?.error(new DOMException('aborted', 'AbortError')), { once: true })
      return Promise.resolve(new Response(body, { status: 200 }))
    }))

    const pending = streamLlamaInference('alias', {
      prompt: 'cancel', maxOutputTokens: 8, temperature: 0, seed: 1,
    }, controller.signal, undefined, { baseUrl: 'http://llama.test', apiKey: '' })
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('uses the configured timeout for stream inference', async () => {
    vi.useFakeTimers()
    try {
      let cancelled = false
      const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, {
        status: 200, headers: { 'Content-Type': 'text/event-stream' },
      })))
      const pending = streamLlamaInference('alias', {
        prompt: 'hello', maxOutputTokens: 12, temperature: 0, seed: 42,
      }, new AbortController().signal, undefined, {
        baseUrl: 'http://llama.test', apiKey: '', inferenceTimeoutMs: 1800000,
      })
      const expectation = expect(pending).rejects.toThrow('llama-server 请求超时')
      await vi.advanceTimersByTimeAsync(120000)
      expect(cancelled).toBe(false)
      await vi.advanceTimersByTimeAsync(1680000)
      await expectation
      expect(cancelled).toBe(true)
      expect(body.locked).toBe(false)
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it('surfaces an SSE server error', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(nextController) {
        nextController.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ error: 'bad stream' })}\n\n`))
        nextController.close()
      },
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })))
    await expect(streamLlamaInference('alias', {
      prompt: 'error', maxOutputTokens: 8, temperature: 0, seed: 1,
    }, new AbortController().signal, undefined, { baseUrl: 'http://llama.test', apiKey: '' })).rejects.toThrow('bad stream')
  })

  it.each([
    ['data: {broken}\n\n', 'JSON'],
    ['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', '[DONE]'],
  ])('rejects a malformed or truncated llama SSE stream', async (data, error) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(data)); controller.close() },
    }))))
    await expect(streamLlamaInference('alias', { prompt: 'x', maxOutputTokens: 8, temperature: 0, seed: 1 },
      new AbortController().signal, undefined, { baseUrl: 'http://llama.test', apiKey: '' })).rejects.toThrow(error)
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
