import { describe, expect, it, vi } from 'vitest'
import { speedupForResults } from '../metrics'
import type { BackendClient, BackendKind, EngineResult, StreamUpdateHandler } from '../types'
import { emptyMetrics, InferenceRunner } from './inferenceRunner'

const params = { prompt: 'hi', maxOutputTokens: 16, temperature: 0, seed: 42 }
const ids = { buddy: 'b', llama: 'l' }
const success = (backend: BackendKind): EngineResult => ({ backend, modelId: ids[backend], text: 'final',
  status: 'success', finishReason: 'completed', metrics: { ...emptyMetrics(), tokensPerSecond: backend === 'buddy' ? 10 : 5, metricsSource: 'backend' } })
const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function setup() {
  const buddy = deferred<EngineResult>()
  const llama = deferred<EngineResult>()
  let buddyUpdate: StreamUpdateHandler = () => undefined
  let llamaUpdate: StreamUpdateHandler = () => undefined
  const clients = {
    buddy: { runInference: vi.fn().mockResolvedValue(success('buddy')), streamInference: vi.fn((_id, _params, _signal, callback) => { buddyUpdate = callback; return buddy.promise }) },
    llama: { runInference: vi.fn().mockImplementation(() => llama.promise), streamInference: vi.fn((_id, _params, _signal, callback) => { llamaUpdate = callback; return llama.promise }) },
  } as unknown as Record<BackendKind, BackendClient> & Record<BackendKind, { runInference: ReturnType<typeof vi.fn>; streamInference: ReturnType<typeof vi.fn> }>
  const states: string[] = []
  const runner = new InferenceRunner(clients, (state) => states.push(`${state.runState}:${state.engineStatuses.buddy}:${state.engineStatuses.llama}`))
  const progress = (callback: StreamUpdateHandler, text: string) => callback({ delta: text, text, timeToFirstTokenMs: 12, finishReason: null })
  return { runner, clients, buddy, llama, states,
    buddyProgress: (text: string) => progress(buddyUpdate, text),
    llamaProgress: (text: string) => progress(llamaUpdate, text) }
}

describe('inference runner state coordination', () => {
  it('keeps non-stream as default path and lets either available backend run alone', async () => {
    const { runner, clients, llama } = setup()
    await runner.run('buddy', ids, params, false)
    expect(clients.buddy.runInference).toHaveBeenCalledTimes(1)
    expect(clients.buddy.streamInference).not.toHaveBeenCalled()
    expect(clients.llama.runInference).not.toHaveBeenCalled()

    const llamaPending = runner.run('llama', ids, params, false)
    await vi.waitFor(() => expect(clients.llama.runInference).toHaveBeenCalledTimes(1))
    expect(clients.llama.streamInference).not.toHaveBeenCalled()
    llama.resolve(success('llama'))
    await llamaPending
    expect(runner.state.runState).toBe('completed')
  })

  it('starts both comparison backends together and publishes their progress independently', async () => {
    const { runner, clients, buddy, llama, buddyProgress, llamaProgress } = setup()
    const input = { ...params }
    const models = { ...ids }
    const pending = runner.run('comparison', models, input, true)
    input.prompt = 'modified'; models.buddy = 'changed'
    await vi.waitFor(() => {
      expect(clients.buddy.streamInference).toHaveBeenCalledTimes(1)
      expect(clients.llama.streamInference).toHaveBeenCalledTimes(1)
    })
    buddyProgress('partial')
    llamaProgress('llama partial')
    expect(runner.state).toMatchObject({
      runState: 'running',
      progress: {
        buddy: { text: 'partial', timeToFirstTokenMs: 12 },
        llama: { text: 'llama partial', timeToFirstTokenMs: 12 },
      },
      results: { buddy: null, llama: null },
      engineStatuses: { buddy: 'running', llama: 'running' },
    })
    expect(clients.llama.runInference).not.toHaveBeenCalled()
    buddy.resolve(success('buddy'))
    await vi.waitFor(() => expect(runner.state.engineStatuses).toMatchObject({ buddy: 'success', llama: 'running' }))
    buddyProgress('too late')
    expect(runner.state.progress.buddy).toBeNull()
    expect(clients.buddy.streamInference.mock.calls[0][0]).toBe('b')
    expect(clients.buddy.streamInference.mock.calls[0][1]).toMatchObject({ prompt: 'hi' })
    expect(clients.llama.streamInference.mock.calls[0][0]).toBe('l')
    expect(clients.llama.streamInference.mock.calls[0][1]).toMatchObject({ prompt: 'hi' })
    expect(clients.llama.runInference).not.toHaveBeenCalled()
    expect(runner.state.progress.llama).toMatchObject({ text: 'llama partial' })
    llama.resolve(success('llama'))
    await pending
    expect(runner.state.runState).toBe('completed')
    expect(speedupForResults(runner.state.results.buddy, runner.state.results.llama)).toBe(2)
  })

  it('cancels both comparison requests, retains partial text, and ignores stale callbacks after restart', async () => {
    const { runner, clients, buddy, llama, buddyProgress, llamaProgress } = setup()
    const old = runner.run('comparison', ids, params, true)
    await vi.waitFor(() => {
      expect(clients.buddy.streamInference).toHaveBeenCalledTimes(1)
      expect(clients.llama.streamInference).toHaveBeenCalledTimes(1)
    })
    buddyProgress('partial')
    llamaProgress('llama partial')
    runner.cancel()
    expect(runner.state).toMatchObject({
      runState: 'cancelled',
      results: {
        buddy: { status: 'cancelled', text: 'partial' },
        llama: { status: 'cancelled', text: 'llama partial' },
      },
      engineStatuses: { buddy: 'cancelled', llama: 'cancelled' },
    })
    expect(speedupForResults(runner.state.results.buddy, success('llama'))).toBeNull()
    buddy.reject(new DOMException('aborted', 'AbortError'))
    llama.reject(new DOMException('aborted', 'AbortError'))
    await old
    const fresh = runner.run('buddy', ids, params, false)
    await fresh
    buddyProgress('late')
    llamaProgress('late')
    expect(runner.state).toMatchObject({ runState: 'completed', results: { buddy: { text: 'final' } } })
    expect(clients.llama.runInference).not.toHaveBeenCalled()
  })

  it('lets the other backend finish after one stream fails; disposal stops updates', async () => {
    const { runner, buddy, llama, buddyProgress, states } = setup()
    const pending = runner.run('comparison', ids, params, true)
    buddyProgress('partial')
    buddy.reject(new Error('stream broken'))
    await vi.waitFor(() => expect(runner.state.results.buddy?.status).toBe('error'))
    expect(runner.state.results.buddy).toMatchObject({ text: 'partial', status: 'error', error: 'stream broken' })
    expect(runner.state.engineStatuses.llama).toBe('running')
    llama.resolve(success('llama'))
    await pending
    expect(runner.state.runState).toBe('completed')
    const after = runner.run('comparison', ids, params, true)
    const count = states.length
    runner.dispose()
    buddyProgress('late')
    await after
    expect(states).toHaveLength(count)
  })

  it('cancels before first text without leaving running state', async () => {
    const { runner, buddy } = setup()
    const pending = runner.run('buddy', ids, params, true)
    runner.cancel()
    buddy.reject(new DOMException('aborted', 'AbortError'))
    await pending
    expect(runner.state).toMatchObject({ runState: 'cancelled', engineStatuses: { buddy: 'cancelled' }, results: { buddy: { text: '' } } })
  })
})
