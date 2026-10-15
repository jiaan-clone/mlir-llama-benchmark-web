import { withWallClockFallback } from '../metrics'
import type { BackendClient, BackendKind, EngineResult, EngineStreamUpdate, InferenceMetrics, InferenceRequest } from '../types'
import { isAbortError } from './httpClient'

export type EngineStatus = 'idle' | 'running' | 'success' | 'error' | 'cancelled'
export type RunMode = BackendKind | 'comparison'
export interface RunnerState {
  results: Record<BackendKind, EngineResult | null>
  progress: Record<BackendKind, EngineStreamUpdate | null>
  engineStatuses: Record<BackendKind, EngineStatus>
  runState: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled'
  runMode: RunMode
}

export const emptyMetrics = (): InferenceMetrics => ({ latencyMs: null, timeToFirstTokenMs: null, tokensPerSecond: null,
  promptTokens: null, completionTokens: null, totalTokens: null, metricsSource: 'unavailable' })

export const initialRunnerState = (): RunnerState => ({
  results: { buddy: null, llama: null }, progress: { buddy: null, llama: null },
  engineStatuses: { buddy: 'idle', llama: 'idle' }, runState: 'idle', runMode: 'comparison',
})

type Clients = Record<BackendKind, BackendClient>
type ModelIds = Record<BackendKind, string>

export class InferenceRunner {
  state: RunnerState = initialRunnerState()
  private active: AbortController | null = null
  private disposed = false
  private clients: Clients
  private publish: (state: RunnerState) => void
  private now: () => number

  constructor(clients: Clients, publish: (state: RunnerState) => void, now: () => number = () => performance.now()) {
    this.clients = clients
    this.publish = publish
    this.now = now
  }

  private update(change: Partial<RunnerState>): void {
    if (this.disposed) return
    this.state = { ...this.state, ...change }
    this.publish(this.state)
  }

  private current(controller: AbortController): boolean {
    return !this.disposed && this.active === controller && !controller.signal.aborted
  }

  cancel(): void {
    const controller = this.active
    if (!controller) return
    this.active = null
    controller.abort()
    const results = { ...this.state.results }
    const engineStatuses = { ...this.state.engineStatuses }
    for (const backend of ['buddy', 'llama'] as const) {
      if (engineStatuses[backend] !== 'running') continue
      const progress = this.state.progress[backend]
      results[backend] = {
        backend, modelId: this.runningModelIds?.[backend] ?? '', status: 'cancelled', finishReason: 'cancelled',
        text: progress?.text ?? '', metrics: { ...emptyMetrics(), timeToFirstTokenMs: progress?.timeToFirstTokenMs ?? null },
      }
      engineStatuses[backend] = 'cancelled'
    }
    this.update({ results, engineStatuses, progress: { buddy: null, llama: null }, runState: 'cancelled' })
  }

  private runningModelIds: ModelIds | null = null

  dispose(): void {
    this.disposed = true
    this.active?.abort()
    this.active = null
  }

  async run(mode: RunMode, modelIds: ModelIds, request: InferenceRequest, streamOutput: boolean): Promise<void> {
    if (this.disposed || this.active) return
    const controller = new AbortController()
    this.active = controller
    this.runningModelIds = { ...modelIds }
    const params = { ...request }
    const initial = mode === 'comparison' ? initialRunnerState() : this.state
    const first = mode === 'llama' ? 'llama' : 'buddy'
    if (mode === 'comparison') {
      this.update({ runMode: mode, runState: 'running',
        results: { buddy: null, llama: null },
        progress: { buddy: null, llama: null },
        engineStatuses: { buddy: 'running', llama: 'running' },
      })
    } else {
      this.update({ runMode: mode, runState: 'running',
        results: { ...initial.results, [first]: null },
        progress: { ...initial.progress, [first]: null },
        engineStatuses: { ...initial.engineStatuses, [first]: 'running' },
      })
    }

    const execute = async (backend: BackendKind): Promise<EngineResult> => {
      const startedAt = this.now()
      let settled = false
      try {
        const stream = streamOutput ? this.clients[backend].streamInference : undefined
        if (streamOutput && stream === undefined) {
          throw new Error(`${backend === 'buddy' ? 'Buddy' : 'llama'} 流式客户端不可用。`)
        }
        const onUpdate = (progress: EngineStreamUpdate) => {
          if (settled || !this.current(controller)) return
          this.update({ progress: { ...this.state.progress, [backend]: progress } })
        }
        const result = stream
          ? await stream(modelIds[backend], params, controller.signal, onUpdate)
          : await this.clients[backend].runInference(modelIds[backend], params, controller.signal)
        settled = true
        if (!this.current(controller)) throw new DOMException('The operation was aborted.', 'AbortError')
        const completed = withWallClockFallback(result, this.now() - startedAt)
        const progress = this.state.progress[backend]
        const finalResult = completed.status === 'error' && !completed.text && progress?.text
          ? { ...completed, text: progress.text } : completed
        this.update({ results: { ...this.state.results, [backend]: finalResult },
          progress: { ...this.state.progress, [backend]: null },
          engineStatuses: { ...this.state.engineStatuses, [backend]: finalResult.status } })
        return finalResult
      } catch (error) {
        settled = true
        if (!this.current(controller) || isAbortError(error)) throw error
        const progress = this.state.progress[backend]
        const failed: EngineResult = { backend, modelId: modelIds[backend], text: progress?.text ?? '', status: 'error',
          finishReason: null, error: error instanceof Error ? error.message : '未知后端错误。',
          metrics: { ...emptyMetrics(), timeToFirstTokenMs: progress?.timeToFirstTokenMs ?? null } }
        this.update({ results: { ...this.state.results, [backend]: failed },
          progress: { ...this.state.progress, [backend]: null },
          engineStatuses: { ...this.state.engineStatuses, [backend]: 'error' } })
        return failed
      }
    }

    try {
      if (mode === 'comparison') {
        const [buddyResult, llamaResult] = await Promise.all([execute('buddy'), execute('llama')])
        if (this.current(controller)) this.update({ runState: buddyResult.status === 'error' && llamaResult.status === 'error' ? 'failed' : 'completed' })
      } else {
        const result = await execute(first)
        if (this.current(controller)) this.update({ runState: result.status === 'error' ? 'failed' : 'completed' })
      }
    } catch (error) {
      if (this.current(controller)) {
        if (isAbortError(error)) this.cancel()
        else this.update({ runState: 'failed' })
      }
    } finally {
      if (this.active === controller) this.active = null
    }
  }
}
