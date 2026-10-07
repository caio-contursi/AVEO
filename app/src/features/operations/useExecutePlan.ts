import { useQueryClient } from '@tanstack/react-query'
import type { TransactionSigner } from '@solana/kit'
import { useCallback, useState } from 'react'
import type { AveoSasHookBackend, DeskEvidence, DeskPlan } from '../../api/backend'
import type { ApiContext } from '../../api/context'
import type { DiagnosticReason } from '../../api/diagnostics'
import { failureReason } from '../../api/errors'
import { withDiagnosticParams } from '../../api/explain'
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

export type RunResult = { signature: string; evidence: DeskEvidence } | { error: DiagnosticReason }

/**
 * Assina um plano, envia e verifica com leitura nova. Um envio recusado devolve o motivo;
 * uma confirmação desconhecida fica como status "unknown" na evidência, sem reenvio.
 */
export async function runPlan(
  ctx: ApiContext,
  backend: AveoSasHookBackend,
  signer: TransactionSigner,
  plan: DeskPlan,
  options: { balancesBefore?: bigint[]; onSent?: (signature: string) => void } = {},
): Promise<RunResult> {
  let signature: string
  try {
    signature = await signAndSend(ctx, plan.request, signer, plan.simulation.unitsConsumed)
  } catch (error) {
    const logs = logsOf(error)
    const reason = logs.length > 0 ? failureReason(error, logs, ctx.programId) : { code: 'SimulationFailed' as const, message: error instanceof Error ? error.message : String(error) }
    return { error: withDiagnosticParams(reason, plan) }
  }
  options.onSent?.(signature)
  try {
    const evidence = await backend.verifyOutcome({ cluster: ctx.cluster, plan, signature, balancesBefore: options.balancesBefore })
    return { signature, evidence }
  } catch (error) {
    // Já foi enviada: sem leitura não dá para dizer que falhou nem que confirmou.
    const message = error instanceof Error ? error.message : String(error)
    return { signature, evidence: { status: 'unknown', signature, logs: [], error: { code: 'ConfirmationUnknown', message } } }
  }
}

/** Estado de execução de um plano com a carteira conectada. Nunca reenvia sozinho. */
export function useExecutePlan() {
  const { ctx, backend } = useReadyDesk()
  const { connected } = useWallet()
  const queryClient = useQueryClient()
  const [state, setState] = useState<ExecutionState>({ phase: 'idle' })

  const execute = useCallback(
    async (plan: DeskPlan, options: { balancesBefore?: bigint[] } = {}): Promise<DeskEvidence | undefined> => {
      if (!connected) return undefined
      setState({ phase: 'signing' })
      const result = await runPlan(ctx, backend, connected.signer, plan, {
        ...options,
        onSent: (signature) => setState({ phase: 'verifying', signature }),
      })
      if ('error' in result) {
        setState({ phase: 'error', error: result.error })
        return undefined
      }
      setState({ phase: 'done', signature: result.signature, evidence: result.evidence })
      await queryClient.invalidateQueries()
      return result.evidence
    },
    [backend, connected, ctx, queryClient],
  )

  const reset = useCallback(() => setState({ phase: 'idle' }), [])
  return { state, execute, reset }
}
