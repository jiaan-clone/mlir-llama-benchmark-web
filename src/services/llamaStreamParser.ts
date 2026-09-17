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

/** Interpret llama-server's data-only Chat Completions events. */
export function parseLlamaSseEvent(data: string): ParsedLlamaSseEvent | null {
  if (data.trim() === '[DONE]') return { kind: 'done' }
  let payload: unknown
  try {
    payload = JSON.parse(data) as unknown
  } catch {
    throw new Error('llama-server SSE JSON 无效。')
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
