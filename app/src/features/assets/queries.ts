import { useQueries, useQuery } from '@tanstack/react-query'
import type { Address } from '@solana/kit'
import { readAssets, readClockUnix, readHoldings, readProofs } from '../../api/inventory'
import { useReadyDesk } from '../../app/desk'

export function useAssetsQuery() {
  const { ctx } = useReadyDesk()
  return useQuery({ queryKey: ['assets'], queryFn: () => readAssets(ctx) })
}

export function useProofsQuery() {
  const { ctx } = useReadyDesk()
  return useQuery({ queryKey: ['proofs'], queryFn: () => readProofs(ctx) })
}

export function useHoldingsQuery() {
  const { ctx } = useReadyDesk()
  return useQuery({ queryKey: ['holdings'], queryFn: () => readHoldings(ctx) })
}

export function useClockQuery() {
  const { ctx } = useReadyDesk()
  return useQuery({ queryKey: ['clock'], queryFn: () => readClockUnix(ctx), refetchInterval: 15_000 })
}

export function useInspectQueries(pairs: { mint: Address; wallet: Address }[]) {
  const { backend, ctx } = useReadyDesk()
  return useQueries({
    queries: pairs.map(({ mint, wallet }) => ({
      queryKey: ['inspect', mint, wallet],
      queryFn: () => backend.inspect({ cluster: ctx.cluster, mint, wallet }),
    })),
  })
}
