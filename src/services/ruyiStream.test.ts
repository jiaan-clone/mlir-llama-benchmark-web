import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRuyiClient } from './ruyiClient'
import { streamRuyiInference } from './ruyiStream'

const config = { baseUrl: 'http://ruyi.test/', apiKey: 'key' }
const params = { prompt: 'Say hello', maxOutputTokens: 32, temperature: 0, seed: 7 }
const sse = (type: string, extra: Record<string, unknown> = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`
const delta = (text: string) => sse('response.output_text.delta', { output_index: 0, content_index: 0, delta: text })
const complete = (status: string = 'completed', extra: Record<string, unknown> = {}) => sse(`response.${status}`, {
  response: { status, output: [{ content: [{ type: 'output_text', text: 'Final' }] }], ...extra },
})
const response = (body: ReadableStream<Uint8Array>, contentType = 'text/event-stream; charset=utf-8') =>
  new Response(body, { status: 200, headers: { 'Content-Type': contentType } })
const encoded = (value: string) => new TextEncoder().encode(value)

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('streamRuyiInference', () => {
  it('posts Responses with auth and streams UTF-8 deltas, finishing before connection close', async () => {
    let cancelled = false
    const bytes = encoded(delta('你') + delta('好') + complete('completed', {
      usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
      ruyi: { execution_metrics: { latency_ms: 250, time_to_first_token_ms: 40, tokens_per_second: 8 } },
    }))
    const split = bytes.findIndex((byte) => byte >= 128) + 1
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes.slice(0, split)); controller.enqueue(bytes.slice(split)) },
      cancel() { cancelled = true },
    })
    const fetchMock = vi.fn().mockResolvedValue(response(body))
    vi.stubGlobal('fetch', fetchMock)
    let time = 100
    const updates: string[] = []
    const result = await streamRuyiInference('buddy-id', params, new AbortController().signal,
      (update) => { updates.push(update.text); time += 10 }, config, () => time)
    expect(updates).toEqual(['你', '你好'])
    expect(result).toMatchObject({ status: 'success', text: 'Final', metrics: { latencyMs: 250, timeToFirstTokenMs: 40, tokensPerSecond: 8, metricsSource: 'backend' } })
    expect(cancelled).toBe(true)
    expect(fetchMock.mock.calls[0][0]).toBe('http://ruyi.test/v1/responses')
    const request = fetchMock.mock.calls[0][1] as RequestInit
    expect(new Headers(request.headers).get('Accept')).toBe('text/event-stream')
    expect(new Headers(request.headers).get('Authorization')).toBe('Bearer key')
    expect(JSON.parse(String(request.body))).toMatchObject({ model: 'buddy-id', stream: true,
      input: [{ content: [{ type: 'input_text', text: 'Say hello' }] }], ruyi: { backend_options: { seed: 7 } }, max_output_tokens: 32 })
    expect(createRuyiClient(config).streamInference).toBeTypeOf('function')
  })

  it('uses first nonempty delta for TTFT and preserves unknown token counts', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded(delta('')))
        controller.enqueue(encoded(delta('a') + complete('incomplete', { output: [] })))
        controller.close()
      },
    })))
    vi.stubGlobal('fetch', fetchMock)
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(16).mockReturnValueOnce(32)
    const result = await streamRuyiInference('model', params, new AbortController().signal, undefined, config, now)
    expect(result).toMatchObject({ text: 'a', finishReason: 'incomplete', metrics: {
      timeToFirstTokenMs: 16, latencyMs: 32, tokensPerSecond: null, completionTokens: null,
    } })
  })

  it.each([
    ['no terminal', delta('a'), '未收到终止事件'],
    ['malformed', 'event: response.output_text.delta\ndata: {broken}\n\n', 'JSON'],
    ['error', sse('error', { error: { message: 'compute offline' }, sequence_number: 0 }), 'compute offline'],
    ['failed', complete('failed', { error: { message: 'backend failed' } }), 'backend failed'],
  ])('handles %s without treating the stream as successful', async (_name, data, message) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoded(data)); controller.close() },
    }))))
    if (_name === 'failed') {
      await expect(streamRuyiInference('model', params, new AbortController().signal, undefined, config))
        .resolves.toMatchObject({ status: 'error', error: message })
    } else {
      await expect(streamRuyiInference('model', params, new AbortController().signal, undefined, config)).rejects.toThrow(message)
    }
  })

  it('rejects a 2xx non-SSE body and cleans it up', async () => {
    let cancelled = false
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true } }), 'text/html')))
    await expect(streamRuyiInference('model', params, new AbortController().signal, undefined, config)).rejects.toThrow('text/event-stream')
    expect(cancelled).toBe(true)
  })

  it('surfaces HTTP errors before reading SSE', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":{"message":"no model"}}', { status: 404 })))
    await expect(streamRuyiInference('model', params, new AbortController().signal, undefined, config)).rejects.toThrow('no model')
  })

  it('cancels a pending read and releases its stream on user cancellation', async () => {
    const parent = new AbortController()
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(body)))
    const pending = streamRuyiInference('model', params, parent.signal, undefined, config)
    await vi.waitFor(() => expect(body.locked).toBe(true))
    parent.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancelled).toBe(true)
    expect(body.locked).toBe(false)
  })

  it('reports a body-read timeout as a service timeout and releases the stream', async () => {
    vi.useFakeTimers()
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(body)))
    const pending = streamRuyiInference('model', params, new AbortController().signal, undefined, { ...config, inferenceTimeoutMs: 1800000 })
    const expectation = expect(pending).rejects.toThrow('ruyi-serving 请求超时')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(cancelled).toBe(false)
    await vi.advanceTimersByTimeAsync(1680000)
    await expectation
    expect(cancelled).toBe(true)
    expect(body.locked).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})
