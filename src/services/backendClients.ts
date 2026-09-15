import { llamaClient } from './llamaClient'
import { ruyiClient } from './ruyiClient'
import type { BackendClient, BackendKind } from '../types'

export const backendClients: Record<BackendKind, BackendClient> = {
  buddy: ruyiClient,
  llama: llamaClient,
}
