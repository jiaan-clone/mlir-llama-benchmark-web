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
  let onUpdate: StreamUpdateHandler = () => undefined
  const clients = {
    buddy: { runInference: vi.fn().mockResolvedValue(success('buddy')), streamInference: vi.fn((_id, _params, _signal, callback) => { onUpdate = callback; return buddy.promise }) },
    llama: { runInference: vi.fn().mockImplementation(() => llama.promise) },
  } as unknown as Record<BackendKind, BackendClient> & { buddy: { runInference: ReturnType<typeof vi.fn>; streamInference: ReturnType<typeof vi.fn> }; llama: { runInference: ReturnType<typeof vi.fn> } }
  const states: string[] = []
  const runner = new InferenceRunner(clients, (state) => states.push(`${state.runState}:${state.engineStatuses.buddy}:${state.engineStatuses.llama}`))
  return { runner, clients, buddy, llama, states, progress: (text: string) => onUpdate({ delta: text, text, timeToFirstTokenMs: 12, finishReason: null }) }
}

describe('inference runner state coordination', () => {
  it('keeps non-stream as default path and lets one available backend run alone', async () => {
    const { runner, clients } = setup()
    await runner.run('buddy', ids, params, false)
    expect(clients.buddy.runInference).toHaveBeenCalledTimes(1)
    expect(clients.buddy.streamInference).not.toHaveBeenCalled()
    expect(clients.llama.runInference).not.toHaveBeenCalled()
    expect(runner.state.runState).toBe('completed')
  })

  it('publishes progress without success and starts llama only after Buddy terminal', async () => {
    const { runner, clients, buddy, llama, progress } = setup()
    const input = { ...params }
    const models = { ...ids }
    const pending = runner.run('comparison', models, input, true)
    input.prompt = 'modified'; models.buddy = 'changed'
    progress('partial')
    expect(runner.state).toMatchObject({ runState: 'running', progress: { buddy: { text: 'partial', timeToFirstTokenMs: 12 } }, results: { buddy: null } })
    expect(clients.llama.runInference).not.toHaveBeenCalled()
    buddy.resolve(success('buddy'))
    await vi.waitFor(() => expect(clients.llama.runInference).toHaveBeenCalledTimes(1))
    progress('too late')
    expect(runner.state.progress.buddy).toBeNull()
    expect(clients.buddy.streamInference.mock.calls[0][0]).toBe('b')
    expect(clients.buddy.streamInference.mock.calls[0][1]).toMatchObject({ prompt: 'hi' })
    expect(clients.llama.runInference.mock.calls[0][1]).toMatchObject({ prompt: 'hi' })
    llama.resolve(success('llama'))
    await pending
    expect(runner.state.runState).toBe('completed')
    expect(speedupForResults(runner.state.results.buddy, runner.state.results.llama)).toBe(2)
  })

  it('retains partial text after cancellation, prevents second request and ignores stale callbacks after restart', async () => {
    const { runner, clients, buddy, progress } = setup()
    const old = runner.run('comparison', ids, params, true)
    progress('partial')
    runner.cancel()
    expect(runner.state).toMatchObject({ runState: 'cancelled', results: { buddy: { status: 'cancelled', text: 'partial' }, llama: null }, engineStatuses: { llama: 'idle' } })
    expect(speedupForResults(runner.state.results.buddy, success('llama'))).toBeNull()
    const fresh = runner.run('buddy', ids, params, false)
    await fresh
    progress('late')
    buddy.resolve(success('buddy'))
    await old
    expect(runner.state).toMatchObject({ runState: 'completed', results: { buddy: { text: 'final' } } })
    expect(clients.llama.runInference).not.toHaveBeenCalled()
  })

  it('handles stream failure with retained output and still tries llama; disposal stops updates', async () => {
    const { runner, buddy, llama, progress, states } = setup()
    const pending = runner.run('comparison', ids, params, true)
    progress('partial')
    buddy.reject(new Error('stream broken'))
    await vi.waitFor(() => expect(runner.state.engineStatuses.llama).toBe('running'))
    expect(runner.state.results.buddy).toMatchObject({ text: 'partial', status: 'error', error: 'stream broken' })
    llama.resolve(success('llama'))
    await pending
    expect(runner.state.runState).toBe('completed')
    const after = runner.run('comparison', ids, params, true)
    const count = states.length
    runner.dispose()
    progress('late')
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
