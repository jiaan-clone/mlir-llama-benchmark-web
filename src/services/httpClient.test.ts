import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpClientError, requestJson, requestStream } from './httpClient'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('requestStream lifecycle', () => {
  it('rejects a pre-aborted signal and cleans up idempotently', async () => {
    const parent = new AbortController()
    parent.abort()
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      expect(init?.signal?.aborted).toBe(true)
      return Promise.reject(new DOMException('aborted', 'AbortError'))
    }))
    await expect(requestStream({ baseUrl: 'http://example.test', path: '/stream', init: { signal: parent.signal } }))
      .rejects.toMatchObject({ name: 'AbortError' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok')))
    const stream = await requestStream({ baseUrl: 'http://example.test', path: '/stream' })
    stream.cleanup()
    stream.cleanup()
    expect(stream.signal.aborted).toBe(false)
  })

  it('cleans up when reading an HTTP error body fails', async () => {
    vi.useFakeTimers()
    const parent = new AbortController()
    const signal = vi.spyOn(parent.signal, 'removeEventListener')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 503, text: () => Promise.reject(new Error('body failed')),
    }))
    await expect(requestStream({ baseUrl: 'http://example.test', path: '/stream', timeoutMs: 10, init: { signal: parent.signal } }))
      .rejects.toThrow('body failed')
    expect(signal).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('requestJson', () => {
  it('parses JSON and adds authorization without overwriting caller headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(requestJson({
      baseUrl: 'http://example.test/',
      apiKey: 'secret',
      path: '/health',
      init: { headers: { 'X-Test': 'yes' } },
    })).resolves.toEqual({ ok: true })

    const request = fetchMock.mock.calls[0][1] as RequestInit
    const headers = new Headers(request.headers)
    expect(fetchMock.mock.calls[0][0]).toBe('http://example.test/health')
    expect(headers.get('Authorization')).toBe('Bearer secret')
    expect(headers.get('X-Test')).toBe('yes')
  })

  it('returns null for an empty successful response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })))
    await expect(requestJson({ baseUrl: 'http://example.test', path: '/ready' })).resolves.toBeNull()
  })

  it('extracts plain-text and structured HTTP errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad gateway', { status: 502 })))
    await expect(requestJson({ baseUrl: 'http://example.test', path: '/fail' })).rejects.toMatchObject({
      name: 'HttpClientError', kind: 'http', status: 502, message: 'bad gateway',
    })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'no model' } }), { status: 400 })))
    await expect(requestJson({ baseUrl: 'http://example.test', path: '/fail' })).rejects.toThrow('no model')
  })

  it('reports timeout and preserves parent cancellation', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })))
    const timeoutPromise = requestJson({ baseUrl: 'http://example.test', path: '/slow', timeoutMs: 10 })
    const timeoutExpectation = expect(timeoutPromise).rejects.toMatchObject({ kind: 'timeout' })
    await vi.advanceTimersByTimeAsync(10)
    await timeoutExpectation

    const parent = new AbortController()
    const cancelled = requestJson({ baseUrl: 'http://example.test', path: '/cancel', init: { signal: parent.signal } })
    parent.abort()
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('normalizes network failures to a typed error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')))
    const error = await requestJson({ baseUrl: 'http://example.test', path: '/health' }).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(HttpClientError)
    expect((error as HttpClientError).kind).toBe('network')
  })
})
