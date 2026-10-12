import { isAddress, isSignature } from '@solana/kit'
import { z } from 'zod'
import type { ApiContext } from '../../api/context'
import type { BoundSubmissionProof } from '../../api/submission-proof'

export const SUBMISSION_INTENT_STORAGE_KEY = 'aveo.desk.submission-intent.v1'
export const MAX_SUBMISSION_INTENT_BYTES = 2048
export type SubmissionIntentStorage = Pick<Storage, 'getItem' | 'setItem'>
export type SubmissionIntentCoordination = (operation: () => Promise<void>) => Promise<void>
export type SubmissionIntentErrorCode = 'storage-unavailable' | 'lock-unavailable' | 'invalid-record' | 'record-replaced' | 'storage-full' | 'unresolved-intent' | 'invalid-input' | 'not-terminal'

export class SubmissionIntentError extends Error {
  constructor(readonly code: SubmissionIntentErrorCode) {
    super(`Submission safety check failed: ${code}.`)
    this.name = 'SubmissionIntentError'
  }
}

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const intentSchema = z.strictObject({
  version: z.literal(1),
  attemptId: z.uuid(),
  signer: z.string().max(44).refine(isAddress),
  kind: z.enum(['transfer', 'set-binding', 'update-policy']),
  contextFingerprint: hashSchema,
  phase: z.enum(['reserved', 'wallet-invoked']),
  messageFingerprint: hashSchema.optional(),
  signature: z.string().max(88).refine(isSignature).optional(),
}).superRefine((intent, ctx) => {
  if (intent.phase === 'reserved' ? intent.messageFingerprint !== undefined || intent.signature !== undefined : intent.messageFingerprint === undefined) {
    ctx.addIssue({ code: 'custom', message: 'Invalid submission phase.' })
  }
})

export type SubmissionIntent = Readonly<z.infer<typeof intentSchema>>
export type SubmissionAttempt = SubmissionIntent | string
export interface SubmissionIntentSnapshot {
  readonly intent?: SubmissionIntent
  readonly error?: SubmissionIntentErrorCode
}

function fail(code: SubmissionIntentErrorCode): never { throw new SubmissionIntentError(code) }
function same(first: SubmissionIntent | undefined, second: SubmissionIntent | undefined): boolean {
  return JSON.stringify(first) === JSON.stringify(second)
}
function idOf(attempt: SubmissionAttempt): string { return typeof attempt === 'string' ? attempt : attempt.attemptId }

/** Durable send gate, not chain authorization. No transaction bytes or endpoint URLs are stored.
 * All participating tabs must use this origin-wide Web Lock and storage key.
 * Missing data after an observed reservation is ambiguous and remains blocked in this instance.
 */
export class SubmissionIntentStore {
  private snapshot: SubmissionIntentSnapshot = Object.freeze({})
  private readonly listeners = new Set<() => void>()
  private cancellable?: SubmissionIntent
  // Retain the first returned signature even if its durable write fails.
  private pendingSignature?: { attemptId: string; signature: string }

  constructor(
    private readonly storage?: SubmissionIntentStorage,
    private readonly coordinate: SubmissionIntentCoordination | null = null,
    private readonly cryptoProvider: Pick<Crypto, 'randomUUID' | 'subtle'> | undefined = globalThis.crypto,
  ) { this.refreshFromStorage() }

  getSnapshot = (): SubmissionIntentSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private update(intent?: SubmissionIntent, error?: SubmissionIntentErrorCode, notify = true): void {
    if (same(intent, this.snapshot.intent) && error === this.snapshot.error) return
    if (same(intent, this.snapshot.intent)) intent = this.snapshot.intent
    this.snapshot = Object.freeze({ ...(intent ? { intent } : {}), ...(error ? { error } : {}) })
    if (notify) this.publish()
  }

  private publish(): void {
    // A broken view listener must never interrupt durable safety operations.
    for (const listener of this.listeners) { try { listener() } catch { /* View notification only. */ } }
  }

  private read(): SubmissionIntent | undefined {
    if (!this.storage) fail('storage-unavailable')
    let raw: string | null
    try { raw = this.storage.getItem(SUBMISSION_INTENT_STORAGE_KEY) } catch { fail('storage-unavailable') }
    if (raw === null || raw === 'null') return undefined
    // Check character count first to bound the allocation for hostile storage data.
    if (raw.length > MAX_SUBMISSION_INTENT_BYTES || new TextEncoder().encode(raw).length > MAX_SUBMISSION_INTENT_BYTES) fail('invalid-record')
    try { return Object.freeze(intentSchema.parse(JSON.parse(raw))) } catch { fail('invalid-record') }
  }

  private checkedRead(): SubmissionIntent | undefined {
    const stored = this.read()
    const known = this.snapshot.intent
    if (known) {
      if (!stored || stored.attemptId !== known.attemptId || stored.signer !== known.signer || stored.kind !== known.kind || stored.contextFingerprint !== known.contextFingerprint ||
          (known.phase === 'wallet-invoked' && (stored.phase !== known.phase || stored.messageFingerprint !== known.messageFingerprint)) ||
          (known.signature !== undefined && stored.signature !== known.signature && !(stored.signature === undefined && this.pendingSignature?.attemptId === known.attemptId && this.pendingSignature.signature === known.signature))) fail('record-replaced')
    }
    if (stored?.signature && this.pendingSignature?.attemptId === stored.attemptId && stored.signature !== this.pendingSignature.signature) fail('record-replaced')
    return stored
  }

  /** Storage events are hints; ignore their payload and validate bounded current storage. */
  refreshFromStorage(): void {
    try {
      const intent = this.checkedRead()
      this.update(this.pendingSignature && !intent?.signature ? this.snapshot.intent : intent, !this.coordinate ? 'lock-unavailable' : this.pendingSignature && !intent?.signature ? 'storage-unavailable' : undefined)
    } catch (error) { this.report(error) }
  }

  private report(error: unknown): SubmissionIntentError {
    const failure = error instanceof SubmissionIntentError ? error : new SubmissionIntentError('lock-unavailable')
    this.update(this.snapshot.intent, failure.code)
    return failure
  }

  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    try {
      if (!this.coordinate) fail('lock-unavailable')
      let entered = false, completed = false
      let result!: T
      await this.coordinate(async () => {
        if (entered) fail('lock-unavailable')
        entered = true
        result = await operation()
        completed = true
      })
      if (!completed) fail('lock-unavailable')
      return result
    } catch (error) { throw this.report(error) }
  }

  private write(intent?: SubmissionIntent, isCurrent: () => boolean = () => true, expected?: SubmissionIntent): void {
    if (!this.storage) fail('storage-unavailable')
    const raw = JSON.stringify(intent ?? null)
    if (new TextEncoder().encode(raw).length > MAX_SUBMISSION_INTENT_BYTES) fail('storage-full')
    // Notifications can execute arbitrary view callbacks. Validate after earlier
    // callbacks, then keep this persistence boundary free of subscriber reentrancy.
    if (!isCurrent()) fail('unresolved-intent')
    // Even the freshness callback is caller code; compare disk after it returns.
    if (!same(this.read(), expected)) fail('record-replaced')
    const previousSnapshot = this.snapshot
    if (intent) this.update(intent, undefined, false)
    try { this.storage.setItem(SUBMISSION_INTENT_STORAGE_KEY, raw) } catch (error) {
      fail(error instanceof DOMException && error.name === 'QuotaExceededError' ? 'storage-full' : 'storage-unavailable')
    }
    // Never grant wallet invocation or release based on setItem succeeding alone.
    if (!same(this.read(), intent)) fail('record-replaced')
    this.update(intent, undefined, false)
    if (this.snapshot !== previousSnapshot) this.publish()
  }

  private async fingerprint(ctx: ApiContext): Promise<string> {
    try {
      if (!['localnet', 'devnet'].includes(ctx.cluster) || !isAddress(ctx.programId) || !['processed', 'confirmed', 'finalized'].includes(ctx.commitment) ||
          typeof ctx.rpcUrl !== 'string' || !ctx.rpcUrl || typeof ctx.deployment.generatedAt !== 'string' || !ctx.deployment.generatedAt) fail('invalid-input')
      // Include the entire deployment, matching the execution context's scope.
      // Capture synchronously before awaiting crypto, so navigation cannot retarget this hash.
      const raw = JSON.stringify([ctx.cluster, ctx.rpcUrl, ctx.programId, ctx.commitment, ctx.deployment])
      if (raw.length > 64_000) fail('invalid-input')
      const bytes = new TextEncoder().encode(raw)
      if (bytes.length > 64_000 || !this.cryptoProvider) fail('invalid-input')
      const digest = await this.cryptoProvider.subtle.digest('SHA-256', bytes)
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
    } catch { fail('invalid-input') }
  }

  reserve(ctx: ApiContext, signer: string, kind: SubmissionIntent['kind']): Promise<SubmissionIntent> {
    return this.locked(async () => {
      const stored = this.checkedRead()
      this.update(stored)
      if (stored) fail('unresolved-intent')
      const contextFingerprint = await this.fingerprint(ctx)
      let intent: SubmissionIntent
      try {
        intent = Object.freeze(intentSchema.parse({ version: 1, attemptId: this.cryptoProvider?.randomUUID(), signer, kind, contextFingerprint, phase: 'reserved' }))
      } catch { fail('invalid-input') }
      // Refresh after hashing; a nonparticipating writer must not be overwritten silently.
      if (this.checkedRead()) fail('unresolved-intent')
      // Retain a blocker even when a write/read-back fails ambiguously.
      this.update(intent)
      this.write(intent)
      this.cancellable = intent
      return intent
    })
  }

  private owned(attempt: SubmissionAttempt): SubmissionIntent {
    const stored = this.checkedRead()
    if (!stored || stored.attemptId !== idOf(attempt)) fail('record-replaced')
    if (typeof attempt !== 'string' && (attempt.signer !== stored.signer || attempt.kind !== stored.kind || attempt.contextFingerprint !== stored.contextFingerprint)) fail('record-replaced')
    this.update(this.pendingSignature && !stored.signature ? this.snapshot.intent : stored, this.pendingSignature && !stored.signature ? 'storage-unavailable' : undefined)
    return stored
  }

  assertOwned(attempt: SubmissionAttempt): Promise<void> {
    return this.locked(async () => {
      const stored = this.owned(attempt)
      if (this.pendingSignature && !stored.signature) fail('storage-unavailable')
    })
  }

  /** Match the original scope before any recovery RPC, without exposing its endpoint. */
  matchesContext(ctx: ApiContext, attempt: SubmissionAttempt): Promise<boolean> {
    return this.locked(async () => {
      const fingerprint = await this.fingerprint(ctx)
      return this.owned(attempt).contextFingerprint === fingerprint
    })
  }

  /** Call at the exact wallet boundary. A failed/ambiguous boundary cannot be cancelled. */
  startWallet(attempt: SubmissionAttempt, messageFingerprint: string, isCurrent: () => boolean = () => true): Promise<void> {
    if (this.cancellable?.attemptId === idOf(attempt)) this.cancellable = undefined
    return this.locked(async () => {
      if (!isCurrent()) fail('unresolved-intent')
      const stored = this.owned(attempt)
      if (stored.phase !== 'reserved') fail('unresolved-intent')
      if (!hashSchema.safeParse(messageFingerprint).success) fail('invalid-input')
      const next = Object.freeze({ ...stored, phase: 'wallet-invoked' as const, messageFingerprint })
      this.write(next, isCurrent, stored)
    })
  }

  attachSignature(attempt: SubmissionAttempt, signature: string, isCurrent: () => boolean = () => true): Promise<void> {
    return this.locked(async () => {
      if (!isCurrent()) fail('unresolved-intent')
      const stored = this.owned(attempt)
      if (stored.phase !== 'wallet-invoked' || !isSignature(signature)) fail('invalid-input')
      if ((stored.signature && stored.signature !== signature) || (this.pendingSignature && (this.pendingSignature.attemptId !== stored.attemptId || this.pendingSignature.signature !== signature))) fail('record-replaced')
      this.pendingSignature = { attemptId: stored.attemptId, signature }
      if (!stored.signature) this.write(Object.freeze({ ...stored, signature }), isCurrent, stored)
      this.pendingSignature = undefined
      this.update(this.read())
    })
  }

  /** Trust boundary: proof must come from fresh original-context chain verification of
   * the exact signed message (verifySubmissionMessage), never balances or cached UI evidence.
   * A structural proof type cannot authenticate its caller; main owns that verifier wiring.
   */
  settle(ctx: ApiContext, attempt: SubmissionAttempt, proof: BoundSubmissionProof, isCurrent: () => boolean = () => true): Promise<void> {
    return this.locked(async () => {
      const commitment = ctx.commitment
      const contextFingerprint = await this.fingerprint(ctx)
      const stored = this.owned(attempt)
      // Recheck inside the lock after async hashing: a stale view cannot release another session.
      if (!isCurrent()) fail('unresolved-intent')
      if ((commitment !== 'confirmed' && commitment !== 'finalized') || stored.phase !== 'wallet-invoked' || !stored.signature ||
          contextFingerprint !== stored.contextFingerprint || !proof || (proof.status !== 'confirmed' && proof.status !== 'failed') ||
          !Number.isSafeInteger(proof.slot) || proof.slot < 0 || proof.signature !== stored.signature ||
          proof.verifiedMessageFingerprint !== stored.messageFingerprint || this.pendingSignature) fail('not-terminal')
      this.write(undefined, isCurrent, stored)
    })
  }

  /** Only the original reservation capability can certify local pre-wallet noninvocation.
   * Reloaded/foreign records, wallet rejection and unknown-without-signature cannot cancel.
   */
  cancelBeforeWallet(reservation: SubmissionIntent): Promise<void> {
    return this.locked(async () => {
      if (this.cancellable !== reservation) fail('unresolved-intent')
      const stored = this.owned(reservation)
      if (stored.phase !== 'reserved' || stored.signature || this.pendingSignature) fail('unresolved-intent')
      this.write(undefined, () => true, stored)
      this.cancellable = undefined
    })
  }
}

let browserStore: SubmissionIntentStore | undefined

export function getSubmissionIntentStore(): SubmissionIntentStore {
  if (typeof window === 'undefined') return new SubmissionIntentStore()
  if (!browserStore) {
    let storage: SubmissionIntentStorage | undefined
    let coordinate: SubmissionIntentCoordination | null = null
    try { storage = globalThis.localStorage } catch { /* Denied browser storage. */ }
    try {
      const locks = globalThis.navigator?.locks
      if (locks) coordinate = async (operation) => { await locks.request(SUBMISSION_INTENT_STORAGE_KEY, { mode: 'exclusive' }, operation) }
    } catch { /* Denied browser coordination. */ }
    browserStore = new SubmissionIntentStore(storage, coordinate)
    window.addEventListener('storage', (event) => {
      if (storage && event.storageArea === storage && (event.key === SUBMISSION_INTENT_STORAGE_KEY || event.key === null)) browserStore?.refreshFromStorage()
    })
  }
  return browserStore
}
