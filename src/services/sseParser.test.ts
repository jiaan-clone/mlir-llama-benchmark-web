import { describe, expect, it } from 'vitest'
import { parseLlamaSseEvent, SseEventParser } from './sseParser'

describe('SseEventParser', () => {
  it('reassembles events split across chunks and supports CRLF', () => {
    const parser = new SseEventParser()
    expect(parser.push('data: {"choices":[{"delta":{"content":"你')).toEqual([])
    expect(parser.push('好"}}]}\r\n\r\ndata: [DONE]\r\n\r\n')).toEqual([
      '{"choices":[{"delta":{"content":"你好"}}]}',
      '[DONE]',
    ])
  })

  it('flushes an unterminated final event and ignores comments', () => {
    const parser = new SseEventParser()
    expect(parser.push(': keep-alive\n\ndata: {"choices":[]}')).toEqual([])
    expect(parser.flush()).toEqual(['{"choices":[]}'])
  })
})

describe('llama SSE event parsing', () => {
  it('parses empty deltas and finish metadata safely', () => {
    expect(parseLlamaSseEvent(JSON.stringify({
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { completion_tokens: 3 },
    }))).toMatchObject({ kind: 'delta', delta: '', finishReason: 'stop', usage: { completion_tokens: 3 } })
  })

  it('recognizes DONE and surfaces server errors', () => {
    expect(parseLlamaSseEvent(' [DONE] ')).toEqual({ kind: 'done' })
    expect(() => parseLlamaSseEvent(JSON.stringify({ error: { message: 'stream failed' } }))).toThrow('stream failed')
  })
})
