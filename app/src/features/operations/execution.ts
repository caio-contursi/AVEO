import type { TransactionSigner } from '@solana/kit'
import type { AveoSasHookBackend, DeskEvidence, DeskPlan } from '../../api/backend'
import type { ApiContext } from '../../api/context'
import type { DiagnosticReason } from '../../api/diagnostics'
import { failureReason } from '../../api/errors'
import { withDiagnosticParams } from '../../api/explain'
import { signAndSend } from '../../api/transactions'

export type ExecutionPhase = 'idle' | 'signing' | 'verifying' | 'done' | 'error'
export interface ExecutionState {
  phase: ExecutionPhase
  signature?: string
  evidence?: DeskEvidence
  error?: DiagnosticReason
  sendBlocked?: boolean
}
export type RunResult = { signature: string; evidence: DeskEvidence } | { error: DiagnosticReason }
type Backend = Pick<AveoSasHookBackend, 'verifyOutcome'>
interface Submission {
  ctx: ApiContext
  backend: Backend
  plan: DeskPlan
  signature: string
  balancesBefore?: bigint[]
}

function contextKey(ctx: ApiContext): string {
  return JSON.stringify([ctx.cluster, ctx.rpcUrl, ctx.programId, ctx.commitment, ctx.deployment])
}

function unknownEvidence(signature: string, error?: unknown): DeskEvidence {
  return {
    status: 'unknown', signature, logs: [],
    error: { code: 'ConfirmationUnknown', message: error instanceof Error ? error.message : error === undefined ? 'Confirmation has not been established.' : String(error) },
  }
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

/** Verify the original submission using reads only, including after a wallet disconnect. */
export async function recheckSubmission(submission: Submission): Promise<DeskEvidence> {
  const { ctx, backend, plan, signature, balancesBefore } = submission
  try {
    const evidence = await backend.verifyOutcome({ cluster: ctx.cluster, plan, signature, balancesBefore })
    return { ...evidence, signature }
  } catch (error) {
    return unknownEvidence(signature, error)
  }
}

/** Send once; verification failures remain unknown rather than inviting a resend. */
export async function runPlan(
  ctx: ApiContext,
  backend: Backend,
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
  return { signature, evidence: await recheckSubmission({ ctx, backend, plan, signature, balancesBefore: options.balancesBefore }) }
}

/** Synchronous guards protect against double clicks before React renders again. */
export class PlanExecution {
  state: ExecutionState = { phase: 'idle' }
  private submission?: Submission
  private busy = false
  private generation = 0
  private key?: string
  private submittedKey?: string
  private active = true

  constructor(private readonly publish: (state: ExecutionState) => void) {}

  private update(state: ExecutionState) {
    this.state = state
    if (this.active) this.publish(state)
  }

  setContext(ctx: ApiContext) {
    const key = contextKey(ctx)
    if (this.key !== undefined && this.key !== key) {
      this.generation++
      this.update(this.submission
        ? (this.busy || !this.state.evidence ? this.unknownState() : { ...this.state, phase: 'done' })
        : { phase: 'idle', sendBlocked: this.busy })
    }
    this.key = key
  }

  matchesContext(ctx: ApiContext) {
    return this.submittedKey === undefined || this.submittedKey === contextKey(ctx)
  }

  /** Format retained evidence with the submitted asset and deployment, independent of form edits. */
  get displayMetadata(): Readonly<{ deployment: ApiContext['deployment']; decimals?: number }> | undefined {
    if (!this.submission) return undefined
    const { ctx, plan } = this.submission
    return {
      deployment: ctx.deployment,
      decimals: plan.request.kind === 'transfer' ? plan.request.decimals : undefined,
    }
  }

  private unknownState(): ExecutionState {
    const signature = this.submission!.signature
    return { phase: 'done', signature, evidence: unknownEvidence(signature) }
  }

  async execute(ctx: ApiContext, backend: Backend, signer: TransactionSigner, plan: DeskPlan, options: { balancesBefore?: bigint[] } = {}) {
    this.setContext(ctx)
    if (this.busy || this.submission || this.state.phase === 'done') return undefined
    this.busy = true
    const generation = this.generation
    const balancesBefore = options.balancesBefore?.slice()
    this.submittedKey = contextKey(ctx)
    this.update({ phase: 'signing' })
    try {
      const result = await runPlan(ctx, backend, signer, plan, {
        balancesBefore,
        onSent: (signature) => {
          this.submission = { ctx, backend, plan, signature, balancesBefore }
          if (generation === this.generation) this.update({ phase: 'verifying', signature })
        },
      })
      if (generation !== this.generation) return undefined
      if ('error' in result) {
        this.submittedKey = undefined
        this.update({ phase: 'error', error: result.error })
        return undefined
      }
      this.update({ phase: 'done', signature: result.signature, evidence: result.evidence })
      return result.evidence
    } finally {
      this.busy = false
      if (generation !== this.generation && !this.submission) this.submittedKey = undefined
    }
  }

  async recheck(ctx: ApiContext) {
    this.setContext(ctx)
    if (this.busy || !this.submission || !this.matchesContext(ctx) || this.state.evidence?.status !== 'unknown') return undefined
    this.busy = true
    const generation = this.generation
    const submission = this.submission
    this.update({ ...this.state, phase: 'verifying' })
    try {
      const evidence = await recheckSubmission(submission)
      if (generation !== this.generation) return undefined
      this.update({ phase: 'done', signature: submission.signature, evidence })
      return evidence
    } finally {
      this.busy = false
    }
  }

  reset() {
    // Retain unresolved submissions and pending sends, even when a caller changes its form.
    if (this.busy || (this.submission && (!this.state.evidence || this.state.evidence.status === 'unknown'))) return false
    this.generation++
    this.submission = undefined
    this.submittedKey = undefined
    this.update({ phase: 'idle' })
    return true
  }

  activate() { this.active = true }

  deactivate() {
    this.active = false
    this.generation++
  }
}
