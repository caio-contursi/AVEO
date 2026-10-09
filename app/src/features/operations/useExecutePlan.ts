import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useLayoutEffect, useState } from 'react'
import type { DeskPlan } from '../../api/backend'
import { useReadyDesk } from '../../app/desk'
import { useWallet } from '../../wallet/context'

import { PlanExecution, type ExecutionState } from './execution'

export { runPlan } from './execution'
export type { ExecutionPhase, ExecutionState, RunResult } from './execution'

/** Execute with a wallet; recheck the retained submission using reads only. */
export function useExecutePlan() {
  const { ctx, backend } = useReadyDesk()
  const { connected } = useWallet()
  const queryClient = useQueryClient()
  const [state, setState] = useState<ExecutionState>({ phase: 'idle' })
  const [execution] = useState(() => new PlanExecution(setState))

  useLayoutEffect(() => {
    execution.activate()
    return () => execution.deactivate()
  }, [execution])
  useLayoutEffect(() => { execution.setContext(ctx) }, [execution, ctx])

  const execute = useCallback(
    async (plan: DeskPlan, options: { balancesBefore?: bigint[] } = {}) => {
      if (!connected) return undefined
      const evidence = await execution.execute(ctx, backend, connected.signer, plan, options)
      if (evidence) await queryClient.invalidateQueries()
      return evidence
    },
    [backend, connected, ctx, execution, queryClient],
  )

  const recheck = useCallback(async () => {
    const evidence = await execution.recheck(ctx)
    if (evidence) await queryClient.invalidateQueries()
    return evidence
  }, [ctx, execution, queryClient])

  const reset = useCallback(() => execution.reset(), [execution])
  return { state, execute, recheck, reset, contextMatches: execution.matchesContext(ctx), displayMetadata: execution.displayMetadata }
}
