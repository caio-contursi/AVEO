import type { TransactionSigner } from '@solana/kit'
import type { AveoSasHookBackend, DeskEvidence, DeskPlan } from '../../api/backend'
import type { ApiContext } from '../../api/context'
import type { DiagnosticReason } from '../../api/diagnostics'
import { failureReason } from '../../api/errors'
import { withDiagnosticParams } from '../../api/explain'
import { signAndSend, SubmissionUnknownError } from '../../api/transactions'
import { verifySubmissionMessage } from '../../api/submission-proof'
import { getSubmissionIntentStore, type SubmissionIntent, type SubmissionIntentStore } from './submission-intent'

export type ExecutionPhase = 'idle' | 'signing' | 'verifying' | 'done' | 'error'
export interface ExecutionState {
  phase: ExecutionPhase
  signature?: string
  evidence?: DeskEvidence
  error?: DiagnosticReason
  sendBlocked?: boolean
}
export type RunResult = { signature: string; evidence: DeskEvidence } | { error: DiagnosticReason; sendBlocked?: boolean }
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
export async function recheckSubmission(submission: Submission, store = getSubmissionIntentStore(), expectedAttemptId?: string): Promise<DeskEvidence> {
  const { ctx, backend, plan, signature, balancesBefore } = submission
  try {
    const evidence = await backend.verifyOutcome({ cluster: ctx.cluster, plan, signature, balancesBefore })
    if (evidence.signature !== signature) return unknownEvidence(signature, 'Verification did not identify the original submission.')
    if (evidence.status !== 'unknown') {
      const boundStatus = await reconcileSubmissionIntent(ctx, signature, store, expectedAttemptId)
      if (boundStatus !== undefined && boundStatus !== evidence.status) return unknownEvidence(signature, 'Original transaction evidence has not established this outcome.')
    }
    return { ...evidence, signature }
  } catch (error) {
    return unknownEvidence(signature, error)
  }
}

/** Recover the original durable reservation using reads only; public receipt removal never calls this. */
export async function reconcileSubmissionIntent(ctx: ApiContext, signature: string, store = getSubmissionIntentStore(), expectedAttemptId?: string): Promise<'confirmed' | 'failed' | false | undefined> {
  store.refreshFromStorage()
  const intent = store.getSnapshot().intent
  if (!intent) return expectedAttemptId ? false : undefined
  if ((expectedAttemptId && intent.attemptId !== expectedAttemptId) || intent.signature !== signature || !intent.messageFingerprint) return false
  if (!await store.matchesContext(ctx, intent)) return false
  const proof = await verifySubmissionMessage(ctx, signature, intent.messageFingerprint)
  if (!proof) return false
  await store.settle(ctx, intent, proof)
  return proof.status
}

/** Send once; verification failures remain unknown rather than inviting a resend. */
export async function runPlan(
  ctx: ApiContext,
  backend: Backend,
  signer: TransactionSigner,
  plan: DeskPlan,
  options: { balancesBefore?: bigint[]; onSent?: (signature: string) => void; intentStore?: SubmissionIntentStore } = {},
): Promise<RunResult> {
  const store = options.intentStore ?? getSubmissionIntentStore()
  let reservation: SubmissionIntent
  const blocked = (): RunResult => ({ error: { code: 'ConfirmationUnknown', message: 'Submission safety could not be established. Do not resend; reconcile the original operation.' }, sendBlocked: true })
  try { reservation = await store.reserve(ctx, signer.address, plan.request.kind) } catch { return blocked() }
  let signature: string
  let notified = false
  let walletBoundary = false
  let originalSignature: string | undefined
  let signatureConflict = false
  let recording: Promise<void> = Promise.resolve()
  const onSent = (signature: string) => {
    if (notified) { if (signature !== originalSignature) signatureConflict = true; return }
    notified = true
    originalSignature = signature
    // Preserve the durable blocker if signature persistence fails; never throw through a receipt callback.
    recording = store.attachSignature(reservation, signature).catch(() => {})
    try { options.onSent?.(signature) } catch { /* Recording must not interrupt submission or verification. */ }
  }
  try {
    signature = await signAndSend(ctx, plan.request, signer, plan.simulation.unitsConsumed, onSent, async (fingerprint) => {
      walletBoundary = true
      await store.startWallet(reservation, fingerprint)
      await store.assertOwned(reservation)
    }, async (signature) => {
      await recording
      await store.attachSignature(reservation, signature)
    })
  } catch (error) {
    if (error instanceof SubmissionUnknownError) {
      if (error.signature) {
        onSent(error.signature)
        await recording
        return { signature: originalSignature!, evidence: unknownEvidence(originalSignature!, error) }
      }
      return { error: { code: 'ConfirmationUnknown', message: error.message }, sendBlocked: true }
    }
    if (walletBoundary) return blocked()
    try { await store.cancelBeforeWallet(reservation) } catch { return blocked() }
    const logs = logsOf(error)
    const reason = logs.length > 0 ? failureReason(error, logs, ctx.programId) : { code: 'SimulationFailed' as const, message: error instanceof Error ? error.message : String(error) }
    return { error: withDiagnosticParams(reason, plan) }
  }
  onSent(signature)
  await recording
  if (signatureConflict) return { signature: originalSignature!, evidence: unknownEvidence(originalSignature!, 'Conflicting submission signatures; do not resend.') }
  const evidence = await recheckSubmission({ ctx, backend, plan, signature, balancesBefore: options.balancesBefore }, store, reservation.attemptId)
  return { signature, evidence }
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
  // Session-only: a wallet may broadcast without ever returning its signature.
  private submissionUnknown = false

  constructor(
    private readonly publish: (state: ExecutionState) => void,
    private readonly recordSubmission?: (ctx: ApiContext, signature: string) => void,
  ) {}

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
        : this.submissionUnknown ? { ...this.state, sendBlocked: true } : { phase: 'idle', sendBlocked: this.busy })
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
    if (this.busy || this.submission || this.submissionUnknown || this.state.sendBlocked || this.state.phase === 'done') return undefined
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
          // Recording must not turn an already sent transaction into a send error.
          try { this.recordSubmission?.(ctx, signature) } catch { /* Verification still proceeds. */ }
          if (generation === this.generation) this.update({ phase: 'verifying', signature })
        },
      })
      // Retain safety state before ignoring stale UI results from navigation/unmount.
      if ('error' in result && result.sendBlocked) {
        this.submissionUnknown = true
        const state: ExecutionState = { phase: 'error', error: result.error, sendBlocked: true }
        if (generation === this.generation) this.update(state)
        else this.state = state
        return undefined
      }
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
      if (generation !== this.generation && !this.submission && !this.submissionUnknown) this.submittedKey = undefined
    }
  }

  async recheck(ctx: ApiContext) {
    this.setContext(ctx)
    if (this.busy || !this.submission || !this.matchesContext(ctx) || (this.state.evidence && this.state.evidence.status !== 'unknown')) return undefined
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
    if (this.busy || this.submissionUnknown || (this.submission && (!this.state.evidence || this.state.evidence.status === 'unknown'))) return false
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
