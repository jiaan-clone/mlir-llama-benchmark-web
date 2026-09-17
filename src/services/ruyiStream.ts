import { ruyiConfig } from '../config'
import { withWallClockFallback } from '../metrics'
import type { BackendConfig, EngineResult, InferenceRequest, StreamUpdateHandler } from '../types'
import { HttpClientError, requestStream, withServiceError } from './httpClient'
import { readSseStream } from './readSseStream'
import { parseRuyiStreamEvent, RuyiStreamAggregator } from './ruyiStreamParser'

export function ruyiRequestBody(modelId: string, params: InferenceRequest, stream: boolean) {
  return JSON.stringify({
    model: modelId,
    input: [{ role: 'user', content: [{ type: 'input_text', text: params.prompt }] }],
    max_output_tokens: params.maxOutputTokens,
    temperature: params.temperature,
    ruyi: { backend_options: { seed: params.seed } },
    stream,
  })
}

export async function streamRuyiInference(
  modelId: string,
  params: InferenceRequest,
  signal: AbortSignal,
  onUpdate: StreamUpdateHandler = () => undefined,
  config: BackendConfig = ruyiConfig,
  now: () => number = () => performance.now(),
): Promise<EngineResult> {
  const startedAt = now()
  let stream
  try {
    stream = await requestStream({
      ...config,
      path: '/v1/responses',
      timeoutMs: 120_000,
      init: {
        method: 'POST', signal,
        headers: { Accept: 'text/event-stream' },
        body: ruyiRequestBody(modelId, params, true),
      },
    })
  } catch (error) {
    throw withServiceError(error, 'ruyi-serving')
  }

  try {
    if (!/^text\/event-stream(?:\s*;|\s*$)/i.test(stream.response.headers.get('Content-Type') ?? '')) {
      await stream.response.body?.cancel()
      throw new Error('ruyi-serving 返回的不是 text/event-stream。')
    }
    const aggregator = new RuyiStreamAggregator(modelId)
    let firstTextMs: number | null = null
    await readSseStream(stream.response, stream.signal, (frame) => {
      const event = parseRuyiStreamEvent(frame)
      if (!event) return false
      if (event.kind === 'response.output_text.delta' && event.text && firstTextMs === null) {
        firstTextMs = now() - startedAt
      }
      return aggregator.consume(event, onUpdate, firstTextMs) !== null
    })
    if (signal.aborted || stream.signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    if (!aggregator.result) throw new Error('ruyi-serving 响应流中断：未收到终止事件。')
    return withWallClockFallback(aggregator.result, now() - startedAt, firstTextMs)
  } catch (error) {
    if (stream.didTimeout()) throw withServiceError(new HttpClientError('请求超时。', 'timeout'), 'ruyi-serving')
    throw withServiceError(error, 'ruyi-serving')
  } finally {
    stream.cleanup()
  }
}
