// Public signature receipts only. This journal cannot reconstruct or send transactions.
import { isAddress, isSignature, type Address, type Commitment } from '@solana/kit'
import { z } from 'zod'
import type { ApiContext } from '../../api/context'

const STORAGE_KEY = 'aveo.desk.submissions.v1'
const MAX_RECEIPTS = 100
const MAX_STORAGE_BYTES = 128_000
type JournalStorage = Pick<Storage, 'getItem' | 'setItem'>

const receiptSchema = z.object({
  version: z.literal(1),
  signature: z.string().refine(isSignature),
  submittedAt: z.iso.datetime(),
  cluster: z.enum(['localnet', 'devnet']),
  programId: z.string().refine(isAddress).transform((value) => value as Address),
  commitment: z.enum(['processed', 'confirmed', 'finalized']),
  deploymentGeneratedAt: z.iso.datetime(),
  rpcFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
})

export interface SubmissionReceipt {
  version: 1
  signature: string
  submittedAt: string
  cluster: 'localnet' | 'devnet'
  programId: Address
  commitment: Commitment
  deploymentGeneratedAt: string
  rpcFingerprint: string
}

export type JournalError = 'storage-unavailable' | 'invalid-records' | 'storage-full'

async function fingerprint(rpcUrl: string): Promise<string> {
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(rpcUrl))
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Cached receipts are untrusted browser metadata, never authorization or chain confirmation. */
export class SubmissionJournal {
  private receipts: readonly SubmissionReceipt[] = Object.freeze([])
  private readonly listeners = new Set<() => void>()
  error?: JournalError

  constructor(private readonly storage?: JournalStorage) {
    if (!storage) { this.error = 'storage-unavailable'; return }
    try {
      const text = storage.getItem(STORAGE_KEY)
      if (text === null) return
      if (text.length > MAX_STORAGE_BYTES) throw new Error('oversized journal')
      const parsed = z.array(receiptSchema).max(MAX_RECEIPTS).parse(JSON.parse(text))
      // Do not accept duplicate signatures as separate recovery actions.
      if (new Set(parsed.map((entry) => entry.signature)).size !== parsed.length) throw new Error('duplicate signature')
      this.receipts = Object.freeze(parsed.map((entry) => Object.freeze(entry)))
    } catch {
      this.error = 'invalid-records'
    }
  }

  getSnapshot = (): readonly SubmissionReceipt[] => this.receipts

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private publish(): void {
    this.listeners.forEach((listener) => listener())
  }

  /** Capture after signing returns a signature; a storage error must never trigger another send. */
  async capture(ctx: ApiContext, signature: string): Promise<void> {
    let receipt: SubmissionReceipt
    try {
      receipt = receiptSchema.parse({
        version: 1, signature, submittedAt: new Date().toISOString(),
        cluster: ctx.cluster, programId: ctx.programId, commitment: ctx.commitment,
        deploymentGeneratedAt: ctx.deployment.generatedAt,
        rpcFingerprint: await fingerprint(ctx.rpcUrl),
      })
    } catch {
      throw new Error('Could not create a public submission receipt.')
    }
    // Check again after hashing: concurrent captures of the same signature must deduplicate.
    const existing = this.receipts.find((entry) => entry.signature === signature)
    if (existing) {
      if (!await this.matches(ctx, existing)) throw new Error('Signature already recorded in another context.')
      return
    }
    if (this.receipts.length >= MAX_RECEIPTS) {
      this.error = 'storage-full'
      this.receipts = Object.freeze([...this.receipts])
      this.publish()
      throw new Error('Public submission journal is full.')
    }
    this.receipts = Object.freeze([Object.freeze(receipt), ...this.receipts])
    try {
      if (!this.storage) throw new Error('storage unavailable')
      this.storage.setItem(STORAGE_KEY, JSON.stringify(this.receipts))
      this.error = undefined
    } catch {
      this.error = 'storage-unavailable'
      this.publish()
      throw new Error('Public receipt is available only in this session.')
    }
    this.publish()
  }

  async matches(ctx: ApiContext, receipt: SubmissionReceipt): Promise<boolean> {
    const parsed = receiptSchema.safeParse(receipt)
    if (!parsed.success) return false
    const entry = parsed.data
    if (entry.cluster !== ctx.cluster || entry.programId !== ctx.programId || entry.commitment !== ctx.commitment || entry.deploymentGeneratedAt !== ctx.deployment.generatedAt) return false
    try { return entry.rpcFingerprint === await fingerprint(ctx.rpcUrl) } catch { return false }
  }
}

let browserJournal: SubmissionJournal | undefined

export function getSubmissionJournal(): SubmissionJournal {
  if (!browserJournal) {
    let storage: JournalStorage | undefined
    try { storage = globalThis.localStorage } catch { /* Private browsing may deny storage access. */ }
    browserJournal = new SubmissionJournal(storage)
  }
  return browserJournal
}
