import { address, createSolanaRpc } from '@solana/kit'
import { useQuery } from '@tanstack/react-query'
import { useMemo, type ReactNode } from 'react'
import { AveoSasHookBackend } from '../api/backend'
import { AVEO_HOOK_PROGRAM_ID } from '../api/constants'
import { createApiContext } from '../api/context'
import { fetchDeployment } from '../config/deployment'
import type { AppEnv } from '../config/env'
import { DeskContext, type DeskServices } from './desk'

export function DeskProvider({ env, children }: { env: AppEnv; children: ReactNode }) {
  const programId = env.VITE_AVEO_PROGRAM_ID ? address(env.VITE_AVEO_PROGRAM_ID) : AVEO_HOOK_PROGRAM_ID
  const deployment = useQuery({
    queryKey: ['deployment', env.VITE_DEPLOYMENT_URL],
    queryFn: () => fetchDeployment(env.VITE_DEPLOYMENT_URL),
    retry: false,
    staleTime: Infinity,
  })

  const value = useMemo<DeskServices>(() => {
    const rpc = createSolanaRpc(env.VITE_RPC_URL)
    const ctx = deployment.data
      ? createApiContext({
          cluster: env.VITE_CLUSTER,
          rpcUrl: env.VITE_RPC_URL,
          commitment: env.VITE_COMMITMENT,
          programId,
          deployment: deployment.data,
        })
      : null
    return {
      env,
      programId,
      commitment: env.VITE_COMMITMENT,
      rpcReader: { rpc, commitment: env.VITE_COMMITMENT, programId },
      deployment: deployment.data ?? null,
      deploymentError: deployment.error,
      deploymentLoading: deployment.isLoading,
      ctx,
      backend: ctx ? new AveoSasHookBackend(ctx) : null,
      explorerUrl: (signature) =>
        env.VITE_CLUSTER === 'devnet' ? `https://explorer.solana.com/tx/${signature}?cluster=devnet` : null,
      refetchDeployment: () => void deployment.refetch(),
    }
  }, [env, programId, deployment])

  return <DeskContext.Provider value={value}>{children}</DeskContext.Provider>
}
