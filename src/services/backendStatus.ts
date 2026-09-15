import type { BackendAvailability, BackendClient, BackendKind, BackendStatus, HealthResponse } from '../types'

export const initialBackendStatus = (): BackendStatus => ({
  healthStatus: 'checking',
  healthError: '',
  models: new Set<string>(),
  modelsLoaded: false,
  modelsError: '',
})

export function isHealthy(payload: HealthResponse): boolean {
  return payload.healthy === true || payload.status === 'ok' || payload.status === 'ready' || payload.status === 'healthy'
}

export function modelIsReady(status: BackendStatus, modelId: string): boolean {
  return status.modelsLoaded && status.models.has(modelId)
}

/** Load one backend's health and models independently so one failure cannot mask the other. */
export async function loadBackendStatus(client: BackendClient, backendLabel: string): Promise<BackendStatus> {
  const [healthResult, modelsResult] = await Promise.allSettled([client.getHealth(), client.getModels()])
  const next = initialBackendStatus()
  if (healthResult.status === 'fulfilled') {
    const healthy = isHealthy(healthResult.value)
    next.healthStatus = healthy ? 'ready' : 'unavailable'
    const statusMessage = typeof healthResult.value.status_message === 'string' ? healthResult.value.status_message : ''
    const message = typeof healthResult.value.message === 'string' ? healthResult.value.message : ''
    next.healthError = healthy ? '' : statusMessage || message || `${backendLabel} 服务未就绪。`
  } else {
    next.healthStatus = 'unavailable'
    next.healthError = healthResult.reason instanceof Error ? healthResult.reason.message : `${backendLabel} 健康检查失败。`
  }
  if (modelsResult.status === 'fulfilled') {
    next.models = new Set(modelsResult.value.map((model) => model.id))
    next.modelsLoaded = true
  } else {
    next.modelsError = modelsResult.reason instanceof Error ? modelsResult.reason.message : `${backendLabel} 模型列表读取失败。`
  }
  return next
}

export function availabilityFor(
  status: BackendStatus,
  engineStatus: 'idle' | 'running' | 'success' | 'error' | 'cancelled',
  modelId: string,
): BackendAvailability {
  if (engineStatus === 'running') return 'running'
  if (status.healthStatus === 'unavailable' || status.modelsError) return 'unavailable'
  if (status.healthStatus === 'checking' || !status.modelsLoaded) return 'checking'
  return modelIsReady(status, modelId) ? 'ready' : 'unavailable'
}

export type BackendStatusMap = Record<BackendKind, BackendStatus>
