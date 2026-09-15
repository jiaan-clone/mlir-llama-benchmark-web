import { useCallback, useEffect, useState } from 'react'
import type { BackendClient, BackendKind } from '../types'
import { initialBackendStatus, loadBackendStatus, type BackendStatusMap } from '../services/backendStatus'

const backendKinds: BackendKind[] = ['buddy', 'llama']

function initialStatusMap(): BackendStatusMap {
  return { buddy: initialBackendStatus(), llama: initialBackendStatus() }
}

export function useBackendStatus(clients: Record<BackendKind, BackendClient>) {
  const [statuses, setStatuses] = useState<BackendStatusMap>(initialStatusMap)

  const refreshStatus = useCallback(async () => {
    setStatuses((current) => ({
      buddy: { ...current.buddy, healthStatus: 'checking', healthError: '', modelsError: '' },
      llama: { ...current.llama, healthStatus: 'checking', healthError: '', modelsError: '' },
    }))

    await Promise.all(backendKinds.map(async (backend) => {
      const next = await loadBackendStatus(clients[backend], backend === 'buddy' ? 'ruyi-serving' : 'llama-server')
      setStatuses((current) => ({ ...current, [backend]: next }))
    }))
  }, [clients])

  useEffect(() => {
    const timer = globalThis.setTimeout(() => { void refreshStatus() }, 0)
    return () => globalThis.clearTimeout(timer)
  }, [refreshStatus])

  return { statuses, refreshStatus }
}
