import { useEffect, useRef, useState } from 'react'
import { InferenceRunner, initialRunnerState } from '../services/inferenceRunner'
import type { RunnerState, RunMode } from '../services/inferenceRunner'
import type { BackendClient, BackendKind, InferenceRequest } from '../types'

export function useInferenceRunner(clients: Record<BackendKind, BackendClient>) {
  const [state, setState] = useState<RunnerState>(initialRunnerState)
  const runnerRef = useRef<InferenceRunner | null>(null)
  useEffect(() => {
    const runner = new InferenceRunner(clients, setState)
    runnerRef.current = runner
    return () => { runner.dispose(); runnerRef.current = null }
  }, [clients])

  return {
    ...state,
    run: (mode: RunMode, modelIds: Record<BackendKind, string>, params: InferenceRequest, streamOutput: boolean) =>
      runnerRef.current?.run(mode, modelIds, params, streamOutput),
    cancel: () => runnerRef.current?.cancel(),
  }
}
