import { describe, expect, it } from 'vitest'
import { NamedSseEventParser, parseLlamaSseEvent, SseEventParser } from './sseParser'

describe('SseEventParser', () => {
  it('reassembles events split across chunks and supports CRLF', () => {
    const parser = new SseEventParser()
    expect(parser.push('data: {"choices":[{"delta":{"content":"你')).toEqual([])
    expect(parser.push('好"}}]}\r\n\r\ndata: [DONE]\r\n\r\n')).toEqual([
      '{"choices":[{"delta":{"content":"你好"}}]}',
      '[DONE]',
    ])
  })

  it('discards an unterminated final event and ignores comments', () => {
    const parser = new SseEventParser()
    expect(parser.push(': keep-alive\n\ndata: {"choices":[]}')).toEqual([])
    expect(parser.flush()).toEqual([])
  })

  it('keeps named events and multi-line/empty data across arbitrary CRLF splits', () => {
    const parser = new NamedSseEventParser()
    expect(parser.push(': ping\r')).toEqual([])
    expect(parser.push('\n\r')).toEqual([])
    expect(parser.push('\nevent: response.output_text.delta\r')).toEqual([])
    expect(parser.push('\ndata: 你\r\ndata: 好\r\nunknown: x\r\n\r')).toEqual([])
    expect(parser.push('\ndata\r\n\r')).toEqual([{ event: 'response.output_text.delta', data: '你\n好' }])
    expect(parser.push('\n')).toEqual([{ event: null, data: '' }])
    expect(parser.flush()).toEqual([])
  })

  it('does not dispatch incomplete lines or half JSON at EOF', () => {
    const parser = new NamedSseEventParser()
    expect(parser.push('event: response.completed\ndata: {"response":')).toEqual([])
    expect(parser.flush()).toEqual([])
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
