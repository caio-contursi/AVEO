import { isSignature } from '@solana/kit'
import type { ApiContext } from '../../api/context'
import { verifySubmissionMessage } from '../../api/submission-proof'
import { getSubmissionIntentStore, type SubmissionIntentStore } from './submission-intent'

export interface SubmissionRecoveryResult {
  status: 'confirmed' | 'failed' | 'unknown' | 'context-mismatch' | 'invalid-signature' | 'blocked' | 'stale' | 'empty'
  signature?: string
  slot?: number
}

function contextKey(ctx: ApiContext): string {
  return JSON.stringify([ctx.cluster, ctx.rpcUrl, ctx.programId, ctx.commitment, ctx.deployment])
}

/** Explicit read-only recovery. A pasted signature is a candidate, never authority to unlock. */
export async function recoverPendingSubmission(
  ctx: ApiContext,
  options: { store?: SubmissionIntentStore; signature?: string; isCurrent?: () => boolean } = {},
): Promise<SubmissionRecoveryResult> {
  const store = options.store ?? getSubmissionIntentStore()
  let current = () => false
  try {
    const key = contextKey(ctx)
    const originalContext = { ...ctx, deployment: structuredClone(ctx.deployment) }
    current = () => {
      try { return (options.isCurrent?.() ?? true) && contextKey(ctx) === key } catch { return false }
    }
    if (!current()) return { status: 'stale' }
    store.refreshFromStorage()
    const { intent, error } = store.getSnapshot()
    if (!intent) return { status: error ? 'blocked' : 'empty' }
    if (intent.phase !== 'wallet-invoked' || !intent.messageFingerprint || originalContext.commitment === 'processed') return { status: 'blocked' }
    const signature = options.signature ?? intent.signature
    // Bound caller input before signature decoding; never retarget a known signature.
    if (typeof signature !== 'string' || signature.length > 88 || !isSignature(signature) || (intent.signature && intent.signature !== signature)) return { status: 'invalid-signature' }
    if (!await store.matchesContext(originalContext, intent)) return { status: 'context-mismatch' }
    if (!current()) return { status: 'stale' }
    const proof = await verifySubmissionMessage(originalContext, signature, intent.messageFingerprint)
    if (!current()) return { status: 'stale' }
    if (!proof) return { status: 'unknown', signature }
    // Persist only a signature verified against the original message, not public receipts.
    await store.attachSignature(intent, signature, current)
    if (!current()) return { status: 'stale' }
    await store.settle(originalContext, intent, proof, current)
    return current() ? { status: proof.status, signature, slot: proof.slot } : { status: 'stale' }
  } catch {
    // No endpoint, transport message or arbitrary RPC log reaches the UI.
    return { status: current() ? 'blocked' : 'stale' }
  }
}
