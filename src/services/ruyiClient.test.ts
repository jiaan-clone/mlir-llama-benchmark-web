import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRuyiClient } from './ruyiClient'

afterEach(() => vi.restoreAllMocks())

describe('ruyi-serving client', () => {
  it('keeps the Responses contract and parses model envelopes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ healthy: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'buddy-id', ready: true }, { id: 7 }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'completed', output: [{ content: [{ type: 'output_text', text: 'ok' }] }],
      }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = createRuyiClient({ baseUrl: 'http://ruyi.test/', apiKey: '' })

    await expect(client.getHealth()).resolves.toMatchObject({ healthy: true })
    await expect(client.getModels()).resolves.toEqual([{ id: 'buddy-id', ready: true }])
    await expect(client.runInference('buddy-id', {
      prompt: 'hello', maxOutputTokens: 12, temperature: 0, seed: 42,
    }, new AbortController().signal)).resolves.toMatchObject({ backend: 'buddy', text: 'ok' })

    expect(fetchMock.mock.calls[2][0]).toBe('http://ruyi.test/v1/responses')
    expect(JSON.parse(String((fetchMock.mock.calls[2][1] as RequestInit).body))).toMatchObject({
      model: 'buddy-id', max_output_tokens: 12, ruyi: { backend_options: { seed: 42 } }, stream: false,
    })
  })

  it('adds the service name to network errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')))
    await expect(createRuyiClient({ baseUrl: 'http://ruyi.test', apiKey: '' }).getHealth())
      .rejects.toThrow('无法连接 ruyi-serving')
  })
})
