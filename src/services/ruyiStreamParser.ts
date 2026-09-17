import type { EngineResult, EngineStreamUpdate } from '../types'
import type { SseEvent } from './sseParser'
import { parseRuyiResponse } from './responseParsers'

type RecordValue = Record<string, unknown>
type Lifecycle = 'response.created' | 'response.in_progress'
type Terminal = 'response.completed' | 'response.incomplete' | 'response.failed'
export type RuyiStreamEvent =
  | { kind: Lifecycle }
  | { kind: 'response.output_text.delta' | 'response.output_text.done'; text: string; outputIndex: number; contentIndex: number }
  | { kind: Terminal; response: RecordValue }
  | { kind: 'error'; message: string }

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null
}

function errorMessage(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value
  const message = record(value)?.message
  return typeof message === 'string' && message.trim() ? message : 'ruyi-serving 流式响应失败。'
}

function index(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`ruyi-serving SSE ${name} 无效。`)
  }
  return value
}

/** Unknown event names are extensions; malformed known events are protocol errors. */
export function parseRuyiStreamEvent(frame: SseEvent): RuyiStreamEvent | null {
  const known = !frame.event || ['response.created', 'response.in_progress', 'response.output_text.delta',
    'response.output_text.done', 'response.completed', 'response.incomplete', 'response.failed', 'error'].includes(frame.event)
  let decoded: unknown
  try { decoded = JSON.parse(frame.data) as unknown } catch {
    if (!known) return null
    throw new Error('ruyi-serving SSE JSON 无效。')
  }
  const payload = record(decoded)
  if (!known && !payload) return null
  if (!payload) throw new Error('ruyi-serving SSE 事件必须为对象。')
  if (payload.type !== undefined && typeof payload.type !== 'string') throw new Error('ruyi-serving SSE type 无效。')
  if (frame.event && payload.type && frame.event !== payload.type) throw new Error('ruyi-serving SSE event 与 type 不一致。')
  if (!known) return null
  const type = frame.event ?? payload.type
  if (type === 'error' || (payload.error !== undefined && !['response.completed', 'response.incomplete', 'response.failed'].includes(type ?? ''))) {
    return { kind: 'error', message: errorMessage(payload.error) }
  }
  if (type === 'response.created' || type === 'response.in_progress') return { kind: type }
  if (type === 'response.output_text.delta' || type === 'response.output_text.done') {
    const field = type === 'response.output_text.delta' ? 'delta' : 'text'
    if (typeof payload[field] !== 'string') throw new Error(`ruyi-serving SSE ${field} 无效。`)
    return { kind: type, text: payload[field], outputIndex: index(payload.output_index, 'output_index'), contentIndex: index(payload.content_index, 'content_index') }
  }
  if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
    const response = record(payload.response)
    if (!response) throw new Error('ruyi-serving SSE 终止事件缺少 response。')
    if (response.status !== type.slice('response.'.length)) throw new Error('ruyi-serving SSE 终态与 response.status 不一致。')
    return { kind: type, response }
  }
  return null
}

/** Stateful protocol aggregation, independent of fetch and React. */
export class RuyiStreamAggregator {
  private modelId: string
  private parts = new Map<number, Map<number, string>>()
  private terminal: EngineResult | null = null
  private seenTerminal = false

  constructor(modelId: string) { this.modelId = modelId }

  get result(): EngineResult | null { return this.terminal }

  get text(): string {
    return [...this.parts.entries()].sort(([a], [b]) => a - b)
      .flatMap(([, parts]) => [...parts.entries()].sort(([a], [b]) => a - b).map(([, text]) => text)).join('')
  }

  consume(event: RuyiStreamEvent, onUpdate: (update: EngineStreamUpdate) => void, firstTextMs: number | null): EngineResult | null {
    if (this.seenTerminal) return this.terminal
    if (event.kind === 'error') throw new Error(event.message)
    if (event.kind === 'response.output_text.delta' || event.kind === 'response.output_text.done') {
      const parts = this.parts.get(event.outputIndex) ?? new Map<number, string>()
      const before = this.text
      parts.set(event.contentIndex, event.kind === 'response.output_text.done'
        ? event.text : (parts.get(event.contentIndex) ?? '') + event.text)
      this.parts.set(event.outputIndex, parts)
      if (this.text !== before) onUpdate({ delta: event.kind === 'response.output_text.delta' ? event.text : '', text: this.text, timeToFirstTokenMs: firstTextMs, finishReason: null })
    }
    if (event.kind === 'response.completed' || event.kind === 'response.incomplete' || event.kind === 'response.failed') {
      this.seenTerminal = true
      const parsed = parseRuyiResponse('buddy', this.modelId, event.response)
      this.terminal = {
        ...parsed,
        text: Array.isArray(event.response.output) && (parsed.text || !this.text) ? parsed.text : this.text,
        ...(event.kind === 'response.failed' ? { error: errorMessage(event.response.error) } : {}),
      }
    }
    return this.terminal
  }
}
