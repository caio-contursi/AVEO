import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useState } from 'react'
import type { DeskEvidence, DeskPlan } from '../../api/backend'
import type { DiagnosticReason } from '../../api/diagnostics'
import { failureReason } from '../../api/errors'
import { signAndSend } from '../../api/transactions'
import { useReadyDesk } from '../../app/desk'
import { useWallet } from '../../wallet/context'

export type ExecutionPhase = 'idle' | 'signing' | 'verifying' | 'done' | 'error'

export interface ExecutionState {
  phase: ExecutionPhase
  signature?: string
  evidence?: DeskEvidence
  error?: DiagnosticReason
}

function logsOf(error: unknown): string[] {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const logs = (current as { context?: { logs?: string[] } }).context?.logs
    if (logs) return logs
    current = (current as { cause?: unknown }).cause
  }
  return []
}

/**
 * Assina com a carteira conectada, envia e verifica com leitura nova.
 * Nunca reenvia sozinho: se a confirmação for desconhecida, o estado fica "unknown" na evidência.
 */
export function useExecutePlan() {
  const { ctx, backend } = useReadyDesk()
  const { connected } = useWallet()
  const queryClient = useQueryClient()
  const [state, setState] = useState<ExecutionState>({ phase: 'idle' })

  const execute = useCallback(
    async (plan: DeskPlan, options: { balancesBefore?: bigint[] } = {}): Promise<DeskEvidence | undefined> => {
      if (!connected) return undefined
      setState({ phase: 'signing' })
      let signature: string
      try {
        signature = await signAndSend(ctx, plan.request, connected.signer, plan.simulation.unitsConsumed)
      } catch (error) {
        const logs = logsOf(error)
        const reason = logs.length > 0 ? failureReason(error, logs, ctx.programId) : { code: 'SimulationFailed' as const, message: error instanceof Error ? error.message : String(error) }
        setState({ phase: 'error', error: reason })
        return undefined
      }
      setState({ phase: 'verifying', signature })
      const evidence = await backend.verifyOutcome({ cluster: ctx.cluster, plan, signature, balancesBefore: options.balancesBefore })
      setState({ phase: 'done', signature, evidence })
      await queryClient.invalidateQueries()
      return evidence
    },
    [backend, connected, ctx, queryClient],
  )

  const reset = useCallback(() => setState({ phase: 'idle' }), [])
  return { state, execute, reset }
}
