export type HttpClientErrorKind = 'network' | 'timeout' | 'http' | 'abort'

export class HttpClientError extends Error {
  readonly kind: HttpClientErrorKind
  readonly status: number | null

  constructor(message: string, kind: HttpClientErrorKind, status: number | null = null) {
    super(message)
    this.name = 'HttpClientError'
    this.kind = kind
    this.status = status
  }
}

export interface HttpRequestOptions {
  baseUrl: string
  apiKey?: string
  path: string
  init?: RequestInit
  timeoutMs?: number
}

export interface HttpStreamResponse {
  response: Response
  cleanup: () => void
  signal: AbortSignal
  didTimeout: () => boolean
}

export function isAbortError(error: unknown): error is DOMException {
  return error instanceof DOMException && error.name === 'AbortError'
}

export function withServiceError(error: unknown, serviceName: string): Error {
  if (isAbortError(error)) return error
  if (error instanceof HttpClientError) {
    if (error.kind === 'network') return new Error(`无法连接 ${serviceName}，请确认服务已启动。`)
    if (error.kind === 'timeout') return new Error(`${serviceName} 请求超时，请确认服务仍在运行或检查后端日志。`)
    if (error.kind === 'abort') return new DOMException('The operation was aborted.', 'AbortError')
    if (error.kind === 'http') return new Error(`${serviceName} 请求失败：${error.message}`)
  }
  return error instanceof Error ? error : new Error('后端请求失败。')
}

function parsePayload(text: string): unknown {
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function extractErrorMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === 'object') {
    const value = payload as Record<string, unknown>
    const error = value.error
    if (typeof error === 'string' && error.trim()) return error
    if (error && typeof error === 'object') {
      const message = (error as Record<string, unknown>).message
      if (typeof message === 'string' && message.trim()) return message
    }
    if (typeof value.message === 'string' && value.message.trim()) return value.message
  }
  if (typeof payload === 'string' && payload.trim()) return payload
  return `请求失败（HTTP ${status}）`
}

/** Fetch JSON or text with shared auth, timeout, cancellation and error semantics. */
export async function requestJson<T = unknown>({
  baseUrl,
  apiKey,
  path,
  init = {},
  timeoutMs = 120_000,
}: HttpRequestOptions): Promise<T | null> {
  const controller = new AbortController()
  const parentSignal = init.signal
  let timedOut = false
  const timeoutId = globalThis.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onParentAbort = () => controller.abort()
  parentSignal?.addEventListener('abort', onParentAbort, { once: true })
  if (parentSignal?.aborted) controller.abort()

  const headers = new Headers(init.headers)
  if (!headers.has('Content-Type') && init.body) headers.set('Content-Type', 'application/json')
  if (apiKey && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${apiKey}`)

  let response: Response
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      signal: controller.signal,
      headers,
    })
  } catch (error) {
    if (parentSignal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError')
    }
    if (timedOut) {
      throw new HttpClientError('请求超时，请确认服务仍在运行或检查后端日志。', 'timeout')
    }
    if (isAbortError(error)) {
      throw new HttpClientError('请求已取消。', 'abort')
    }
    throw new HttpClientError('无法连接后端服务，请确认服务已启动。', 'network')
  } finally {
    globalThis.clearTimeout(timeoutId)
    parentSignal?.removeEventListener('abort', onParentAbort)
  }

  const payload = parsePayload(await response.text())
  if (!response.ok) {
    throw new HttpClientError(extractErrorMessage(payload, response.status), 'http', response.status)
  }
  return payload as T | null
}

/**
 * Start a response-body stream while keeping the shared auth, timeout and
 * parent-signal behavior. The caller must invoke cleanup when the body ends.
 */
export async function requestStream({
  baseUrl,
  apiKey,
  path,
  init = {},
  timeoutMs = 120_000,
}: HttpRequestOptions): Promise<HttpStreamResponse> {
  const controller = new AbortController()
  const parentSignal = init.signal
  let timedOut = false
  let cleanedUp = false
  const timeoutId = globalThis.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onParentAbort = () => controller.abort()
  parentSignal?.addEventListener('abort', onParentAbort, { once: true })
  if (parentSignal?.aborted) controller.abort()

  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    globalThis.clearTimeout(timeoutId)
    parentSignal?.removeEventListener('abort', onParentAbort)
  }

  const headers = new Headers(init.headers)
  if (!headers.has('Content-Type') && init.body) headers.set('Content-Type', 'application/json')
  if (apiKey && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${apiKey}`)

  let response: Response
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      signal: controller.signal,
      headers,
    })
  } catch (error) {
    cleanup()
    if (parentSignal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    if (timedOut) throw new HttpClientError('请求超时，请确认服务仍在运行或检查后端日志。', 'timeout')
    if (isAbortError(error)) throw new HttpClientError('请求已取消。', 'abort')
    throw new HttpClientError('无法连接后端服务，请确认服务已启动。', 'network')
  }

  if (!response.ok) {
    try {
      const payload = parsePayload(await response.text())
      throw new HttpClientError(extractErrorMessage(payload, response.status), 'http', response.status)
    } catch (error) {
      if (error instanceof HttpClientError) throw error
      if (parentSignal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
      if (timedOut) throw new HttpClientError('请求超时。', 'timeout')
      throw error
    } finally {
      cleanup()
    }
  }
  return { response, cleanup, signal: controller.signal, didTimeout: () => timedOut }
}

export { extractErrorMessage }
