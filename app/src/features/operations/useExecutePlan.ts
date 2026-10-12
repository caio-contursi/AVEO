import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { DeskPlan } from '../../api/backend'
import { useReadyDesk } from '../../app/desk'
import { useWallet } from '../../wallet/context'

import { PlanExecution, type ExecutionState } from './execution'
import { getSubmissionJournal } from './submission-journal'

export { runPlan } from './execution'
export type { ExecutionPhase, ExecutionState, RunResult } from './execution'

/** Execute with a wallet; recheck the retained submission using reads only. */
export function useExecutePlan() {
  const { ctx, backend } = useReadyDesk()
  const { connected } = useWallet()
  const queryClient = useQueryClient()
  const [state, setState] = useState<ExecutionState>({ phase: 'idle' })
  const [journalError, setJournalError] = useState(false)
  const active = useRef(false)
  const [execution] = useState(() => new PlanExecution(setState, (submissionContext, signature) => {
    const journal = getSubmissionJournal()
    // Capture even after navigation; only React updates depend on this hook remaining mounted.
    void journal.capture(submissionContext, signature).then(() => {
      if (active.current && journal.error === undefined) setJournalError(false)
    }).catch(() => {
      // Keep RPC details out of persistence warnings; this never retries the send.
      if (active.current) setJournalError(true)
    })
  }))

  useLayoutEffect(() => {
    active.current = true
    execution.activate()
    return () => {
      active.current = false
      execution.deactivate()
    }
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
  return { state, execute, recheck, reset, journalError, contextMatches: execution.matchesContext(ctx), displayMetadata: execution.displayMetadata }
}
