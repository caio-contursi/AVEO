import type { Commitment } from '@solana/kit'
import { createContext, useContext } from 'react'
import type { AveoSasHookBackend } from '../api/backend'
import type { ApiContext } from '../api/context'
import type { AppEnv } from '../config/env'
import type { Deployment } from '../config/deployment'

export interface DeskServices {
  env: AppEnv
  programId: ApiContext['programId']
  commitment: Commitment
  rpcReader: Pick<ApiContext, 'rpc' | 'commitment' | 'programId'>
  deployment: Deployment | null
  deploymentError: unknown
  deploymentLoading: boolean
  /** Contexto completo: só existe quando o manifest de deploy foi carregado. */
  ctx: ApiContext | null
  backend: AveoSasHookBackend | null
  explorerUrl: (signature: string) => string | null
  refetchDeployment: () => void
}

export const DeskContext = createContext<DeskServices | null>(null)

export function useDesk(): DeskServices {
  const value = useContext(DeskContext)
  if (!value) throw new Error('useDesk outside DeskProvider')
  return value
}

/** Para telas que só fazem sentido com o manifest carregado. */
export function useReadyDesk(): DeskServices & { ctx: ApiContext; backend: AveoSasHookBackend; deployment: Deployment } {
  const desk = useDesk()
  if (!desk.ctx || !desk.backend || !desk.deployment) throw new Error('deployment not loaded')
  return desk as DeskServices & { ctx: ApiContext; backend: AveoSasHookBackend; deployment: Deployment }
}
