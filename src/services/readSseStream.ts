import { NamedSseEventParser, type SseEvent } from './sseParser'

/** Reader lifetime belongs here; the request timer/listener belongs to requestStream's caller. */
export async function readSseStream(
  response: Response,
  signal: AbortSignal,
  consume: (event: SseEvent) => boolean | void,
): Promise<void> {
  if (!response.body) throw new Error('未返回可读取的响应流。')
  const reader = response.body.getReader()
  const parser = new NamedSseEventParser()
  const decoder = new TextDecoder()
  const onAbort = () => { void reader.cancel().catch(() => undefined) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    while (true) {
      const { done, value } = await reader.read()
      if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
      if (done) break
      if (!value) continue
      for (const event of parser.push(decoder.decode(value, { stream: true }))) {
        if (consume(event) === true) return
      }
    }
    for (const event of parser.push(decoder.decode())) {
      if (consume(event) === true) return
    }
    parser.flush()
  } finally {
    signal.removeEventListener('abort', onAbort)
    try { await reader.cancel() } catch { /* The stream may already be closed. */ }
    reader.releaseLock()
  }
}
