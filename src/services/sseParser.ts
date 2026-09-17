/** Incremental SSE parser that preserves events split across fetch chunks. */
export class SseEventParser {
  private buffer = ''
  private dataLines: string[] = []

  push(chunk: string): string[] {
    this.buffer += chunk
    const events: string[] = []
    let lineEnd = this.findLineEnd()
    while (lineEnd !== null) {
      const line = this.buffer.slice(0, lineEnd.index)
      this.buffer = this.buffer.slice(lineEnd.nextIndex)
      this.consumeLine(line, events)
      lineEnd = this.findLineEnd()
    }
    return events
  }

  flush(): string[] {
    const events: string[] = []
    if (this.buffer) {
      this.consumeLine(this.buffer, events)
      this.buffer = ''
    }
    this.emitEvent(events)
    return events
  }

  private findLineEnd(): { index: number; nextIndex: number } | null {
    const newlineIndex = this.buffer.indexOf('\n')
    const carriageReturnIndex = this.buffer.indexOf('\r')
    if (newlineIndex === -1 && carriageReturnIndex === -1) return null
    if (newlineIndex === -1 || (carriageReturnIndex !== -1 && carriageReturnIndex < newlineIndex)) {
      return {
        index: carriageReturnIndex,
        nextIndex: this.buffer[carriageReturnIndex + 1] === '\n' ? carriageReturnIndex + 2 : carriageReturnIndex + 1,
      }
    }
    return { index: newlineIndex, nextIndex: newlineIndex + 1 }
  }

  private consumeLine(line: string, events: string[]): void {
    if (!line) {
      this.emitEvent(events)
      return
    }
    if (line.startsWith(':')) return
    if (line.startsWith('data:')) this.dataLines.push(line.slice(5).replace(/^ /, ''))
  }

  private emitEvent(events: string[]): void {
    if (this.dataLines.length === 0) return
    events.push(this.dataLines.join('\n'))
    this.dataLines = []
  }
}

export type ParsedLlamaSseEvent =
  | { kind: 'delta'; delta: string; finishReason: string | null; usage: Record<string, unknown> | null; timings: Record<string, unknown> | null }
  | { kind: 'done' }

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map((part) => {
    const record = asRecord(part)
    return record && typeof record.text === 'string' ? record.text : ''
  }).join('')
}

/** Convert one SSE data payload into a safe llama streaming event. */
export function parseLlamaSseEvent(data: string): ParsedLlamaSseEvent | null {
  if (data.trim() === '[DONE]') return { kind: 'done' }
  let payload: unknown
  try {
    payload = JSON.parse(data) as unknown
  } catch {
    return null
  }
  const root = asRecord(payload)
  if (!root) return null
  if (root.error !== undefined) {
    const message = typeof root.error === 'string' ? root.error : asRecord(root.error)?.message
    throw new Error(typeof message === 'string' && message.trim() ? message : 'llama-server 流式响应失败。')
  }
  const choices = Array.isArray(root.choices) ? root.choices : []
  const choice = asRecord(choices[0])
  const delta = asRecord(choice?.delta)
  return {
    kind: 'delta',
    delta: contentText(delta?.content),
    finishReason: stringOrNull(choice?.finish_reason),
    usage: asRecord(root.usage),
    timings: asRecord(root.timings),
  }
}
