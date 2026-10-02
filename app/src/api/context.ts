// Contexto compartilhado pela camada de API: RPC, rede, programa e manifest de deploy.
import type { Cluster } from '@aveo/contracts'
import { createSolanaRpc, type Address, type Commitment, type Rpc, type SolanaRpcApi } from '@solana/kit'
import type { Deployment } from '../config/deployment'

export interface ApiContext {
  cluster: Cluster
  rpcUrl: string
  rpc: Rpc<SolanaRpcApi>
  commitment: Commitment
  programId: Address
  deployment: Deployment
}

export function createApiContext(options: {
  cluster: Cluster
  rpcUrl: string
  commitment: Commitment
  programId: Address
  deployment: Deployment
}): ApiContext {
  return { ...options, rpc: createSolanaRpc(options.rpcUrl) }
}
