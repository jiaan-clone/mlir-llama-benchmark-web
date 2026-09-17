import { describe, expect, it, vi } from 'vitest'
import { parseRuyiStreamEvent, RuyiStreamAggregator } from './ruyiStreamParser'

const frame = (type: string, fields: Record<string, unknown> = {}, named = true) => ({
  event: named ? type : null,
  data: JSON.stringify({ type, ...fields }),
})
const text = (kind: 'delta' | 'done', value: unknown, output_index = 0, content_index = 0) => frame(`response.output_text.${kind}`, {
  output_index, content_index, [kind === 'delta' ? 'delta' : 'text']: value,
})
const terminal = (kind: 'completed' | 'incomplete' | 'failed', output: unknown[] = []) => frame(`response.${kind}`, {
  response: { status: kind, output, usage: { input_tokens: 4, output_tokens: 2 }, ruyi: { execution_metrics: { latency_ms: 250, time_to_first_token_ms: 40, tokens_per_second: 8 } }, error: kind === 'failed' ? { message: 'backend failed' } : null },
})

describe('Responses event contract', () => {
  it('supports named and data-only events, empty text, and unknown events', () => {
    expect(parseRuyiStreamEvent(frame('response.created'))).toEqual({ kind: 'response.created' })
    expect(parseRuyiStreamEvent(text('delta', '', 0, 0))).toMatchObject({ kind: 'response.output_text.delta', text: '' })
    expect(parseRuyiStreamEvent(frame('response.in_progress', {}, false))).toEqual({ kind: 'response.in_progress' })
    expect(parseRuyiStreamEvent(frame('response.output_item.added'))).toBeNull()
    expect(parseRuyiStreamEvent({ event: 'future.event', data: 'not JSON' })).toBeNull()
    expect(() => parseRuyiStreamEvent({ event: 'future.event', data: '{"type":"response.completed"}' })).toThrow('不一致')
  })

  it('rejects conflicting names, malformed JSON and known damaged fields', () => {
    expect(() => parseRuyiStreamEvent({ event: 'response.created', data: '{' })).toThrow('JSON')
    expect(() => parseRuyiStreamEvent({ event: 'response.created', data: '{"type":"response.completed"}' })).toThrow('不一致')
    expect(() => parseRuyiStreamEvent(text('delta', 12))).toThrow('delta')
    expect(() => parseRuyiStreamEvent(text('delta', 'hello', -1))).toThrow('output_index')
    expect(() => parseRuyiStreamEvent(frame('response.completed'))).toThrow('缺少 response')
    expect(() => parseRuyiStreamEvent(frame('response.completed', { response: { status: 'failed' } }))).toThrow('不一致')
  })

  it('aggregates separate parts, calibrates done and final output without duplication', () => {
    const aggregator = new RuyiStreamAggregator('model')
    const update = vi.fn()
    for (const value of [text('delta', 'A'), text('delta', '', 0, 0), text('delta', 'B', 1, 0), text('delta', 'C', 0, 1), text('done', 'Alpha', 0, 0)]) {
      aggregator.consume(parseRuyiStreamEvent(value)!, update, 23)
    }
    expect(aggregator.text).toBe('AlphaCB')
    expect(update).toHaveBeenCalledTimes(4)
    const result = aggregator.consume(parseRuyiStreamEvent(terminal('completed', [{ content: [{ type: 'output_text', text: 'Final' }] }]))!, update, 23)
    expect(result).toMatchObject({ status: 'success', text: 'Final', metrics: { completionTokens: 2, timeToFirstTokenMs: 40 } })
    aggregator.consume(parseRuyiStreamEvent(text('delta', 'ignored'))!, update, 23)
    aggregator.consume(parseRuyiStreamEvent(terminal('failed'))!, update, 23)
    expect(aggregator.result).toEqual(result)
  })

  it('keeps incomplete as success but surfaces failed and error events', () => {
    const truncated = new RuyiStreamAggregator('model')
    expect(truncated.consume(parseRuyiStreamEvent(terminal('incomplete'))!, vi.fn(), null)).toMatchObject({ status: 'success', finishReason: 'incomplete' })
    const failed = new RuyiStreamAggregator('model')
    expect(failed.consume(parseRuyiStreamEvent(terminal('failed'))!, vi.fn(), null)).toMatchObject({ status: 'error', error: 'backend failed' })
    expect(() => new RuyiStreamAggregator('model').consume(parseRuyiStreamEvent(frame('error', { error: { message: 'compute offline' }, sequence_number: 0 }))!, vi.fn(), null)).toThrow('compute offline')
    expect(new RuyiStreamAggregator('model').result).toBeNull()
  })
})
