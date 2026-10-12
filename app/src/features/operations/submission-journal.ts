// Public signature receipts only. This journal cannot reconstruct or send transactions.
import { isAddress, isSignature, type Address, type Commitment } from '@solana/kit'
import { z } from 'zod'
import type { ApiContext } from '../../api/context'
import { MAX_RECEIPTS, MAX_RECEIPT_BYTES, receiptUtf8Bytes } from './receipt-limits'

const STORAGE_KEY = 'aveo.desk.submissions.v1'
type JournalStorage = Pick<Storage, 'getItem' | 'setItem'>
export type JournalCoordinationLock = (operation: () => Promise<void>) => Promise<void>
const SESSION_WARNING = 'Public receipt is available only in this session.'

class JournalFailure extends Error {
  constructor(readonly code: JournalError, message: string) { super(message) }
}

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

function sameContext(first: SubmissionReceipt, second: SubmissionReceipt): boolean {
  return first.cluster === second.cluster && first.programId === second.programId && first.commitment === second.commitment && first.deploymentGeneratedAt === second.deploymentGeneratedAt && first.rpcFingerprint === second.rpcFingerprint
}

async function fingerprint(rpcUrl: string): Promise<string> {
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(rpcUrl))
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Cached receipts are untrusted browser metadata, never authorization or chain confirmation. */
export class SubmissionJournal {
  private receipts: readonly SubmissionReceipt[] = Object.freeze([])
  private readonly listeners = new Set<() => void>()
  private readonly volatile = new Map<string, SubmissionReceipt>()
  private queue: Promise<void> = Promise.resolve()
  error?: JournalError

  // Omitted coordination supports legacy single-instance injected storage.
  // Browser callers explicitly pass null when Web Locks are unavailable.
  constructor(private readonly storage?: JournalStorage, private readonly coordinate: JournalCoordinationLock | null = async (operation) => { await operation() }) {
    this.refreshFromStorage()
  }

  private read(): readonly SubmissionReceipt[] {
    if (!this.storage) throw new JournalFailure('storage-unavailable', SESSION_WARNING)
    let text: string | null
    try { text = this.storage.getItem(STORAGE_KEY) } catch { throw new JournalFailure('storage-unavailable', SESSION_WARNING) }
    try {
      if (text === null) return []
      if (receiptUtf8Bytes(text) > MAX_RECEIPT_BYTES) throw new Error('oversized journal')
      const parsed = z.array(receiptSchema).max(MAX_RECEIPTS).parse(JSON.parse(text))
      // Do not accept duplicate signatures as separate recovery actions.
      if (new Set(parsed.map((entry) => entry.signature)).size !== parsed.length) throw new Error('duplicate signature')
      return parsed.map((entry) => Object.freeze(entry))
    } catch {
      throw new JournalFailure('invalid-records', SESSION_WARNING)
    }
  }

  private merge(stored: readonly SubmissionReceipt[]): readonly SubmissionReceipt[] {
    for (const local of this.volatile.values()) {
      const incoming = stored.find((entry) => entry.signature === local.signature)
      if (incoming && !sameContext(local, incoming)) throw new JournalFailure('invalid-records', SESSION_WARNING)
    }
    return [...Array.from(this.volatile.values()).filter((entry) => !stored.some((other) => other.signature === entry.signature)), ...stored]
  }

  private acknowledgePersisted(stored: readonly SubmissionReceipt[]): void {
    // Call only after the entire merge and its capacity checks have succeeded.
    for (const incoming of stored) {
      const local = this.volatile.get(incoming.signature)
      if (local && sameContext(local, incoming)) this.volatile.delete(incoming.signature)
    }
  }

  private update(entries: readonly SubmissionReceipt[], error?: JournalError): void {
    // Reuse unchanged objects for stable external-store snapshots.
    const next = entries.map((entry) => this.receipts.find((old) => JSON.stringify(old) === JSON.stringify(entry)) ?? Object.freeze(entry))
    if (this.error === error && next.length === this.receipts.length && next.every((entry, i) => entry === this.receipts[i])) return
    this.receipts = Object.freeze(next)
    this.error = error
    this.publish()
  }

  /** Storage events are hints: always validate the actual current storage value. */
  refreshFromStorage(): void {
    try {
      const stored = this.read()
      const entries = this.merge(stored)
      this.checkCapacity(entries)
      this.acknowledgePersisted(stored)
      this.update(entries, !this.coordinate || this.volatile.size > 0 ? 'storage-unavailable' : undefined)
    } catch (error) {
      this.update(this.receipts, error instanceof JournalFailure ? error.code : 'storage-unavailable')
    }
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.queue.then(operation)
    this.queue = result.catch(() => {})
    return result
  }

  private checkCapacity(entries: readonly SubmissionReceipt[]): void {
    if (entries.length > MAX_RECEIPTS || receiptUtf8Bytes(JSON.stringify(entries)) > MAX_RECEIPT_BYTES) {
      throw new JournalFailure('storage-full', 'Public submission journal is full.')
    }
  }

  private write(entries: readonly SubmissionReceipt[]): void {
    this.checkCapacity(entries)
    if (!this.storage) throw new JournalFailure('storage-unavailable', SESSION_WARNING)
    try { this.storage.setItem(STORAGE_KEY, JSON.stringify(entries)) } catch { throw new JournalFailure('storage-unavailable', SESSION_WARNING) }
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
  capture(ctx: ApiContext, signature: string): Promise<void> {
    return this.enqueue(() => this.captureQueued(ctx, signature))
  }

  private async captureQueued(ctx: ApiContext, signature: string): Promise<void> {
    let receipt: SubmissionReceipt
    try {
      receipt = Object.freeze(receiptSchema.parse({
        version: 1, signature, submittedAt: new Date().toISOString(),
        cluster: ctx.cluster, programId: ctx.programId, commitment: ctx.commitment,
        deploymentGeneratedAt: ctx.deployment.generatedAt,
        rpcFingerprint: await fingerprint(ctx.rpcUrl),
      }))
    } catch {
      throw new Error('Could not create a public submission receipt.')
    }
    let conflict = false
    const checkContext = (entries: readonly SubmissionReceipt[]) => {
      const existing = entries.find((entry) => entry.signature === signature)
      if (existing && !sameContext(existing, receipt)) {
        conflict = true
        throw new Error('Signature already recorded in another context.')
      }
      return existing
    }
    const retain = (entries: readonly SubmissionReceipt[]) => {
      if (checkContext(entries)) return entries
      const next = [receipt, ...entries]
      this.checkCapacity(next)
      this.volatile.set(signature, receipt)
      return next
    }
    try {
      if (!this.coordinate) throw new JournalFailure('storage-unavailable', SESSION_WARNING)
      await this.coordinate(async () => {
        const stored = this.read()
        const fresh = this.merge(stored)
        checkContext(fresh)
        this.checkCapacity(fresh)
        this.update(fresh, this.volatile.size > 0 ? 'storage-unavailable' : undefined)
        const next = retain(fresh)
        // Retry only this signature, preserving its original immutable receipt.
        // Other volatile captures must not resurrect receipts another tab removed.
        const requested = next.find((entry) => entry.signature === signature)!
        const persisted = stored.some((entry) => entry.signature === signature) ? stored : [requested, ...stored]
        this.checkCapacity(persisted)
        this.acknowledgePersisted(stored)
        if (persisted !== stored) {
          this.write(persisted)
          this.acknowledgePersisted(persisted)
        }
        this.update(this.merge(persisted), this.volatile.size > 0 ? 'storage-unavailable' : undefined)
      })
    } catch (error) {
      if (conflict) throw error
      let failure = error instanceof JournalFailure ? error : new JournalFailure('storage-unavailable', SESSION_WARNING)
      if (failure.code !== 'storage-full') {
        try { this.update(retain(this.receipts), failure.code) } catch (retentionError) {
          if (conflict) throw retentionError
          failure = retentionError as JournalFailure
        }
      }
      this.update(this.receipts, failure.code)
      throw new Error(failure.code === 'storage-full' ? 'Public submission journal is full.' : SESSION_WARNING)
    }
  }

  /** Explicitly forget one public receipt; never clear the journal automatically. */
  remove(signature: string): Promise<void> {
    return this.enqueue(async () => {
      if (!isSignature(signature)) throw new Error('Could not remove a public submission receipt.')
      if (!this.coordinate || !this.storage) {
        try {
          // A session capture may since have been persisted by another tab.
          const persisted = this.storage ? this.read() : []
          if (persisted.some((entry) => entry.signature === signature) || (!this.volatile.has(signature) && this.receipts.some((entry) => entry.signature === signature))) {
            throw new JournalFailure('storage-unavailable', SESSION_WARNING)
          }
        } catch (error) {
          this.update(this.receipts, error instanceof JournalFailure ? error.code : 'storage-unavailable')
          throw new Error('Could not remove the public submission receipt from storage.')
        }
        this.volatile.delete(signature)
        this.update(this.receipts.filter((entry) => entry.signature !== signature), 'storage-unavailable')
        return
      }
      try {
        await this.coordinate(async () => {
          const stored = this.read()
          const merged = this.merge(stored)
          this.checkCapacity(merged)
          const next = stored.filter((entry) => entry.signature !== signature)
          this.checkCapacity(next)
          this.acknowledgePersisted(stored)
          this.write(next)
          this.volatile.delete(signature)
          this.update(this.merge(next), this.volatile.size > 0 ? 'storage-unavailable' : undefined)
        })
      } catch (error) {
        this.update(this.receipts, error instanceof JournalFailure ? error.code : 'storage-unavailable')
        throw new Error('Could not remove the public submission receipt from storage.')
      }
    })
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
  // Do not create a singleton or install event listeners during SSR.
  if (typeof window === 'undefined') return new SubmissionJournal()
  if (!browserJournal) {
    let storage: JournalStorage | undefined
    try { storage = globalThis.localStorage } catch { /* Private browsing may deny storage access. */ }
    let coordinate: JournalCoordinationLock | null = null
    try {
      const locks = globalThis.navigator?.locks
      if (locks) coordinate = async (operation) => { await locks.request(STORAGE_KEY, { mode: 'exclusive' }, operation) }
    } catch { /* Restricted browsers may deny Web Locks access. */ }
    browserJournal = new SubmissionJournal(storage, coordinate)
    window.addEventListener('storage', (event) => {
      if (storage && event.storageArea === storage && (event.key === STORAGE_KEY || event.key === null)) browserJournal?.refreshFromStorage()
    })
  }
  return browserJournal
}
