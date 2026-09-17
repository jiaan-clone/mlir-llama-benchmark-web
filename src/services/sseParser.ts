export interface SseEvent { event: string | null; data: string }

/** Only dispatch fully framed SSE events (a blank line); discard EOF fragments. */
export class NamedSseEventParser {
  private buffer = ''
  private dataLines: string[] = []
  private eventName: string | null = null

  push(chunk: string): SseEvent[] {
    this.buffer += chunk
    const events: SseEvent[] = []
    let lineEnd = this.findLineEnd()
    while (lineEnd !== null) {
      const line = this.buffer.slice(0, lineEnd.index)
      this.buffer = this.buffer.slice(lineEnd.nextIndex)
      this.consumeLine(line, events)
      lineEnd = this.findLineEnd()
    }
    return events
  }

  flush(): SseEvent[] {
    this.buffer = ''
    this.dataLines = []
    this.eventName = null
    return []
  }

  private findLineEnd(): { index: number; nextIndex: number } | null {
    const newlineIndex = this.buffer.indexOf('\n')
    const carriageReturnIndex = this.buffer.indexOf('\r')
    if (newlineIndex === -1 && carriageReturnIndex === -1) return null
    if (newlineIndex === -1 || (carriageReturnIndex !== -1 && carriageReturnIndex < newlineIndex)) {
      if (carriageReturnIndex === this.buffer.length - 1) return null
      return {
        index: carriageReturnIndex,
        nextIndex: this.buffer[carriageReturnIndex + 1] === '\n' ? carriageReturnIndex + 2 : carriageReturnIndex + 1,
      }
    }
    return { index: newlineIndex, nextIndex: newlineIndex + 1 }
  }

  private consumeLine(line: string, events: SseEvent[]): void {
    if (!line) {
      this.emitEvent(events)
      return
    }
    if (line.startsWith(':')) return
    const separator = line.indexOf(':')
    const field = separator < 0 ? line : line.slice(0, separator)
    const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '')
    if (field === 'data') this.dataLines.push(value)
    if (field === 'event') this.eventName = value || null
  }

  private emitEvent(events: SseEvent[]): void {
    if (this.dataLines.length) events.push({ event: this.eventName, data: this.dataLines.join('\n') })
    this.dataLines = []
    this.eventName = null
  }
}

/** Compatibility wrapper for llama's data-only SSE protocol. */
export class SseEventParser {
  private parser = new NamedSseEventParser()
  push(chunk: string): string[] { return this.parser.push(chunk).map((event) => event.data) }
  flush(): string[] { return this.parser.flush().map((event) => event.data) }
}

export { parseLlamaSseEvent } from './llamaStreamParser'
export type { ParsedLlamaSseEvent } from './llamaStreamParser'
