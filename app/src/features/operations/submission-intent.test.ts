import { getAddressDecoder, getBase58Decoder } from '@solana/kit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiContext } from '../../api/context'
import type { BoundSubmissionProof } from '../../api/submission-proof'
import {
  MAX_SUBMISSION_INTENT_BYTES, SUBMISSION_INTENT_STORAGE_KEY, SubmissionIntentStore,
  type SubmissionIntentCoordination,
} from './submission-intent'

const signer = getAddressDecoder().decode(new Uint8Array(32).fill(7))
const signature = (n = 1) => getBase58Decoder().decode(new Uint8Array(64).fill(n))
const messageFingerprint = 'a'.repeat(64)
const ctx = {
  cluster: 'localnet', programId: signer, commitment: 'confirmed',
  rpcUrl: 'https://user:password@rpc.invalid/?apiKey=private-token',
  deployment: { generatedAt: '2026-10-09T12:00:00.000Z' },
} as ApiContext
const proof = (patch: Partial<BoundSubmissionProof> = {}): BoundSubmissionProof => ({
  signature: signature(), status: 'confirmed', slot: 5, verifiedMessageFingerprint: messageFingerprint, ...patch,
})

function storage() {
  let raw: string | null = null
  return {
    getItem: vi.fn(() => raw),
    setItem: vi.fn((_key: string, value: string) => { raw = value }),
    replace: (value: string | null) => { raw = value },
    raw: () => raw,
  }
}
function coordination(): SubmissionIntentCoordination {
  let tail = Promise.resolve()
  return (operation) => {
    const result = tail.then(operation)
    tail = result.catch(() => {})
    return result
  }
}
function setup() {
  const disk = storage(), lock = coordination(), store = new SubmissionIntentStore(disk, lock)
  return { disk, lock, store }
}
async function invoked() {
  const fixture = setup()
  const attempt = await fixture.store.reserve(ctx, signer, 'transfer')
  await fixture.store.startWallet(attempt, messageFingerprint)
  return { ...fixture, attempt }
}
afterEach(() => { vi.unstubAllGlobals() })

describe('durable submission intent safety', () => {
  it('cannot cross the wallet boundary after a queued operation becomes stale', async () => {
    const disk = storage()
    let delay = false, active = true
    let release!: () => void
    const coordinate: SubmissionIntentCoordination = async (operation) => {
      if (delay) await new Promise<void>((resolve) => { release = resolve })
      await operation()
    }
    const store = new SubmissionIntentStore(disk, coordinate)
    const attempt = await store.reserve(ctx, signer, 'transfer')
    const original = disk.raw()
    delay = true
    const pending = store.startWallet(attempt, messageFingerprint, () => active)
    active = false
    release()
    await expect(pending).rejects.toMatchObject({ code: 'unresolved-intent' })
    expect(disk.raw()).toBe(original)
    expect(store.getSnapshot().intent?.phase).toBe('reserved')
  })
  it('does not overwrite a replacement introduced by a reservation subscriber', async () => {
    const { disk, store } = setup()
    let replacement: string | undefined
    store.subscribe(() => {
      const intent = store.getSnapshot().intent
      if (intent && !replacement) {
        replacement = JSON.stringify({ ...intent, attemptId: globalThis.crypto.randomUUID() })
        disk.replace(replacement)
      }
    })
    await expect(store.reserve(ctx, signer, 'transfer')).rejects.toMatchObject({ code: 'record-replaced' })
    expect(disk.raw()).toBe(replacement)
    expect(disk.setItem).not.toHaveBeenCalled()
  })
  it('starts empty, persists bounded public metadata and survives reopening', async () => {
    const { disk, lock, store } = setup()
    expect(store.getSnapshot()).toEqual({})
    const attempt = await store.reserve(ctx, signer, 'transfer')
    expect(Object.isFrozen(attempt)).toBe(true)
    expect(attempt).toMatchObject({ version: 1, signer, kind: 'transfer', phase: 'reserved' })
    expect(attempt.attemptId).toMatch(/^[a-f0-9-]{36}$/)
    expect(attempt.contextFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(disk.raw()!.length).toBeLessThan(MAX_SUBMISSION_INTENT_BYTES)
    for (const secret of ['password', 'private-token', 'rpc.invalid', 'rpcUrl', 'transaction', 'secretKey']) expect(disk.raw()).not.toContain(secret)
    const reopened = new SubmissionIntentStore(disk, lock)
    expect(reopened.getSnapshot().intent).toEqual(attempt)
    await expect(reopened.reserve(ctx, signer, 'transfer')).rejects.toMatchObject({ code: 'unresolved-intent' })
    await expect(reopened.cancelBeforeWallet(attempt)).rejects.toMatchObject({ code: 'unresolved-intent' })
  })

  it('allows only one concurrent reservation across instances and different contexts', async () => {
    const { disk, lock, store } = setup()
    const other = new SubmissionIntentStore(disk, lock)
    const results = await Promise.allSettled([
      store.reserve(ctx, signer, 'transfer'), other.reserve({ ...ctx, rpcUrl: 'https://other.invalid' }, signer, 'update-policy'),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(disk.setItem).toHaveBeenCalledTimes(1)
    other.refreshFromStorage()
    expect(other.getSnapshot().intent).toEqual(store.getSnapshot().intent)
  })

  it('rejects duplicate reservations within one instance without overwriting', async () => {
    const { disk, store } = setup()
    const results = await Promise.allSettled([store.reserve(ctx, signer, 'transfer'), store.reserve(ctx, signer, 'transfer')])
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(disk.setItem).toHaveBeenCalledTimes(1)
  })

  it('fails closed with unavailable storage or locks and never writes without locks', async () => {
    const disk = storage()
    for (const store of [new SubmissionIntentStore(undefined, coordination()), new SubmissionIntentStore(disk), new SubmissionIntentStore(disk, async () => { throw new Error('private detail') }), new SubmissionIntentStore(disk, async () => {})]) {
      await expect(store.reserve(ctx, signer, 'transfer')).rejects.toThrow('Submission safety check failed')
      expect(store.getSnapshot().error).toBeDefined()
    }
    expect(disk.setItem).not.toHaveBeenCalled()
  })

  it('rejects malformed, unknown-version, oversized and extra-field records without writing', async () => {
    const { disk, lock, store } = setup()
    const attempt = await store.reserve(ctx, signer, 'transfer')
    for (const raw of ['{', '{}', '[]', ' '.repeat(MAX_SUBMISSION_INTENT_BYTES + 1), JSON.stringify({ ...attempt, version: 2 }), JSON.stringify({ ...attempt, rpcUrl: 'secret' }), JSON.stringify({ ...attempt, phase: 'wallet-invoked' })]) {
      disk.replace(raw)
      disk.setItem.mockClear()
      const reopened = new SubmissionIntentStore(disk, lock)
      expect(reopened.getSnapshot().error).toBe('invalid-record')
      await expect(reopened.reserve(ctx, signer, 'transfer')).rejects.toMatchObject({ code: 'invalid-record' })
      expect(disk.raw()).toBe(raw)
      expect(disk.setItem).not.toHaveBeenCalled()
    }
  })

  it('retains a blocker on quota, read failure and failed reservation read-back', async () => {
    for (const mode of ['quota', 'read', 'silent-write']) {
      const { disk, store } = setup()
      if (mode === 'quota') disk.setItem.mockImplementation(() => { throw new DOMException('private detail', 'QuotaExceededError') })
      if (mode === 'read') disk.setItem.mockImplementation(() => { disk.getItem.mockImplementation(() => { throw new Error('private detail') }) })
      if (mode === 'silent-write') disk.setItem.mockImplementation(() => {})
      await expect(store.reserve(ctx, signer, 'transfer')).rejects.toThrow('Submission safety check failed')
      expect(store.getSnapshot().intent?.phase).toBe('reserved')
      const writes = disk.setItem.mock.calls.length
      await expect(store.reserve(ctx, signer, 'transfer')).rejects.toThrow()
      expect(disk.setItem).toHaveBeenCalledTimes(writes)
    }
  })

  it('reads back ownership before invocation and rejects replaced, removed or altered records', async () => {
    for (const replacement of ['id', 'signer', 'kind', 'context', 'missing']) {
      const { disk, store } = setup()
      const attempt = await store.reserve(ctx, signer, 'transfer')
      const replaced = { ...attempt }
      if (replacement === 'id') replaced.attemptId = globalThis.crypto.randomUUID()
      if (replacement === 'signer') replaced.signer = getAddressDecoder().decode(new Uint8Array(32).fill(8))
      if (replacement === 'kind') replaced.kind = 'update-policy'
      if (replacement === 'context') replaced.contextFingerprint = 'b'.repeat(64)
      disk.replace(replacement === 'missing' ? null : JSON.stringify(replaced))
      disk.setItem.mockClear()
      await expect(store.assertOwned(attempt)).rejects.toMatchObject({ code: 'record-replaced' })
      await expect(store.startWallet(attempt, messageFingerprint)).rejects.toThrow()
      expect(store.getSnapshot().intent).toEqual(attempt)
      expect(disk.setItem).not.toHaveBeenCalled()
    }
  })

  it('permits only original reservation capability cancellation before wallet invocation', async () => {
    const { disk, store } = setup()
    const attempt = await store.reserve(ctx, signer, 'transfer')
    await expect(store.cancelBeforeWallet({ ...attempt })).rejects.toThrow()
    await store.cancelBeforeWallet(attempt)
    expect(store.getSnapshot()).toEqual({})
    expect(disk.raw()).toBe('null')
    await store.reserve(ctx, signer, 'set-binding')
    await expect(store.cancelBeforeWallet(attempt)).rejects.toThrow()
  })

  it('persists the wallet boundary and message hash before permission, with no replay/cancellation', async () => {
    const { disk, lock, store, attempt } = await invoked()
    expect(JSON.parse(disk.raw()!)).toMatchObject({ phase: 'wallet-invoked', messageFingerprint })
    await store.assertOwned(attempt.attemptId)
    await expect(store.startWallet(attempt, messageFingerprint)).rejects.toMatchObject({ code: 'unresolved-intent' })
    await expect(store.cancelBeforeWallet(attempt)).rejects.toThrow()
    const reopened = new SubmissionIntentStore(disk, lock)
    await expect(reopened.cancelBeforeWallet(attempt)).rejects.toThrow()
    expect(reopened.getSnapshot().intent?.signature).toBeUndefined()
  })

  it('keeps ambiguous boundary persistence blocked, including string attempt IDs', async () => {
    for (const useId of [false, true]) {
      const { disk, store } = setup()
      const attempt = await store.reserve(ctx, signer, 'transfer')
      disk.setItem.mockImplementationOnce(() => { throw new Error('quota') })
      await expect(store.startWallet(useId ? attempt.attemptId : attempt, messageFingerprint)).rejects.toThrow()
      await expect(store.cancelBeforeWallet(attempt)).rejects.toThrow()
      await expect(store.startWallet(attempt, messageFingerprint)).rejects.toThrow()
      expect(JSON.parse(disk.raw()!).phase).toBe('reserved')
      expect(store.getSnapshot().intent?.phase).toBe('wallet-invoked')
    }
  })

  it('rejects invalid boundary hashes and signatures before attaching', async () => {
    const { store } = setup()
    const attempt = await store.reserve(ctx, signer, 'transfer')
    await expect(store.attachSignature(attempt, signature())).rejects.toThrow()
    await expect(store.startWallet(attempt, 'bad')).rejects.toThrow()
    await store.startWallet(attempt, messageFingerprint)
    await expect(store.attachSignature(attempt, 'bad')).rejects.toThrow()
    expect(store.getSnapshot().intent?.signature).toBeUndefined()
  })

  it('attaches exactly one immutable signature, including cross-tab late writes', async () => {
    const { disk, lock, store, attempt } = await invoked()
    const other = new SubmissionIntentStore(disk, lock)
    await store.attachSignature(attempt, signature())
    await other.attachSignature(attempt.attemptId, signature())
    const before = disk.raw()
    await expect(other.attachSignature(attempt, signature(2))).rejects.toMatchObject({ code: 'record-replaced' })
    expect(disk.raw()).toBe(before)
    await store.settle(ctx, attempt, proof())
    const next = await store.reserve(ctx, signer, 'transfer')
    await expect(other.attachSignature(attempt, signature())).rejects.toThrow()
    expect(JSON.parse(disk.raw()!).attemptId).toBe(next.attemptId)
  })

  it('preserves the no-signature disk blocker and first signature on attachment failure, with safe retry', async () => {
    const { disk, lock, store, attempt } = await invoked()
    disk.setItem.mockImplementationOnce(() => { throw new DOMException('quota', 'QuotaExceededError') })
    await expect(store.attachSignature(attempt, signature())).rejects.toMatchObject({ code: 'storage-full' })
    expect(JSON.parse(disk.raw()!).signature).toBeUndefined()
    expect(store.getSnapshot().intent?.signature).toBe(signature())
    store.refreshFromStorage()
    expect(store.getSnapshot().intent?.signature).toBe(signature())
    await expect(store.settle(ctx, attempt, proof())).rejects.toThrow()
    await expect(store.attachSignature(attempt, signature(2))).rejects.toThrow()
    await expect(new SubmissionIntentStore(disk, lock).reserve(ctx, signer, 'transfer')).rejects.toThrow()
    await store.attachSignature(attempt, signature())
    await store.settle(ctx, attempt, proof())
    expect(store.getSnapshot()).toEqual({})
  })

  it('rejects phase/message/signature rollback and retains the last observed record', async () => {
    for (const field of ['phase', 'message', 'signature']) {
      const { disk, store, attempt } = await invoked()
      await store.attachSignature(attempt, signature())
      const known = store.getSnapshot().intent!
      const replaced = field === 'phase' ? attempt : field === 'message' ? { ...known, messageFingerprint: 'b'.repeat(64) } : { ...known, signature: signature(2) }
      disk.replace(JSON.stringify(replaced))
      store.refreshFromStorage()
      expect(store.getSnapshot().intent).toBe(known)
      expect(store.getSnapshot().error).toBe('record-replaced')
    }
  })

  it('settles confirmed or failed original-message proofs only, allowing a new attempt', async () => {
    for (const status of ['confirmed', 'failed'] as const) {
      const { store, attempt } = await invoked()
      await store.attachSignature(attempt, signature())
      await store.settle(ctx, attempt.attemptId, proof({ status }))
      const next = await store.reserve(ctx, signer, 'update-policy')
      expect(next.attemptId).not.toBe(attempt.attemptId)
      await expect(store.settle(ctx, attempt, proof())).rejects.toThrow()
      expect(store.getSnapshot().intent?.attemptId).toBe(next.attemptId)
    }
  })

  it('rejects unknown, missing/mismatched signatures, message hashes and invalid slots', async () => {
    const { disk, store, attempt } = await invoked()
    await store.attachSignature(attempt, signature())
    const before = disk.raw()
    for (const patch of [{ status: 'unknown' }, { signature: undefined }, { signature: signature(2) }, { verifiedMessageFingerprint: 'b'.repeat(64) }, { verifiedMessageFingerprint: undefined }, ...[-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1].map((slot) => ({ slot }))]) {
      await expect(store.settle(ctx, attempt, { ...proof(), ...patch } as BoundSubmissionProof)).rejects.toMatchObject({ code: 'not-terminal' })
      expect(disk.raw()).toBe(before)
    }
  })

  it('requires original context, attached signature, and confirmed/finalized commitment', async () => {
    const { disk, store, attempt } = await invoked()
    await expect(store.settle(ctx, attempt, proof())).rejects.toThrow()
    await store.attachSignature(attempt, signature())
    const before = disk.raw()
    for (const patch of [{ cluster: 'devnet' }, { programId: getAddressDecoder().decode(new Uint8Array(32).fill(8)) }, { rpcUrl: 'https://other.invalid' }, { commitment: 'finalized' }, { deployment: { generatedAt: 'changed' } }]) {
      await expect(store.settle({ ...ctx, ...patch } as ApiContext, attempt, proof())).rejects.toThrow()
      expect(disk.raw()).toBe(before)
    }
    const processed = setup(), processedCtx = { ...ctx, commitment: 'processed' as const }
    const pending = await processed.store.reserve(processedCtx, signer, 'transfer')
    await processed.store.startWallet(pending, messageFingerprint)
    await processed.store.attachSignature(pending, signature())
    await expect(processed.store.settle(processedCtx, pending, proof())).rejects.toThrow()
    const finalized = setup(), finalCtx = { ...ctx, commitment: 'finalized' as const }
    const finalAttempt = await finalized.store.reserve(finalCtx, signer, 'transfer')
    await finalized.store.startWallet(finalAttempt, messageFingerprint)
    await finalized.store.attachSignature(finalAttempt, signature())
    await finalized.store.settle(finalCtx, finalAttempt, proof({ slot: 0 }))
  })

  it('preserves blockers on failed release and treats another tab release conservatively', async () => {
    const { disk, lock, store, attempt } = await invoked()
    await store.attachSignature(attempt, signature())
    const other = new SubmissionIntentStore(disk, lock)
    disk.setItem.mockImplementationOnce(() => { throw new Error('quota') })
    await expect(store.settle(ctx, attempt, proof())).rejects.toThrow()
    expect(store.getSnapshot().intent?.signature).toBe(signature())
    await store.settle(ctx, attempt, proof())
    other.refreshFromStorage()
    expect(other.getSnapshot().error).toBe('record-replaced')
    expect(other.getSnapshot().intent?.attemptId).toBe(attempt.attemptId)
    expect(new SubmissionIntentStore(disk, lock).getSnapshot()).toEqual({})
  })

  it('has stable snapshots, bounded subscriptions and harmless listener failures', async () => {
    const { store } = setup()
    const initial = store.getSnapshot(), listener = vi.fn(), unsubscribe = store.subscribe(listener)
    store.subscribe(() => { throw new Error('view failure') })
    store.refreshFromStorage()
    expect(store.getSnapshot()).toBe(initial)
    const attempt = await store.reserve(ctx, signer, 'transfer')
    const snapshot = store.getSnapshot()
    store.refreshFromStorage()
    expect(store.getSnapshot()).toBe(snapshot)
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    await store.cancelBeforeWallet(attempt)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('wires one browser singleton to scoped storage hints; SSR and missing locks fail closed', async () => {
    const disk = storage(), lock = coordination()
    let hint: ((event: StorageEvent) => void) | undefined
    const addEventListener = vi.fn((_name: string, listener: (event: StorageEvent) => void) => { hint = listener })
    const request = vi.fn((_key: string, _options: unknown, callback: () => Promise<void>) => lock(callback))
    vi.stubGlobal('window', { addEventListener })
    vi.stubGlobal('localStorage', disk)
    vi.stubGlobal('navigator', { locks: { request } })
    vi.resetModules()
    const { getSubmissionIntentStore } = await import('./submission-intent')
    const store = getSubmissionIntentStore()
    expect(getSubmissionIntentStore()).toBe(store)
    expect(addEventListener).toHaveBeenCalledTimes(1)
    const writer = new SubmissionIntentStore(disk, lock)
    const attempt = await writer.reserve(ctx, signer, 'transfer')
    const emit = (key: string | null, area: unknown) => hint!({ key, storageArea: area, newValue: '{' } as StorageEvent)
    emit('wrong-key', disk)
    emit(SUBMISSION_INTENT_STORAGE_KEY, storage())
    expect(store.getSnapshot().intent).toBeUndefined()
    emit(SUBMISSION_INTENT_STORAGE_KEY, disk)
    expect(store.getSnapshot().intent).toEqual(attempt)
    await store.assertOwned(attempt)
    expect(request).toHaveBeenCalledWith(SUBMISSION_INTENT_STORAGE_KEY, { mode: 'exclusive' }, expect.any(Function))
    disk.replace('{')
    emit(null, disk)
    expect(store.getSnapshot().error).toBe('invalid-record')
    vi.stubGlobal('navigator', {})
    vi.resetModules()
    const missing = (await import('./submission-intent')).getSubmissionIntentStore()
    await expect(missing.reserve(ctx, signer, 'transfer')).rejects.toThrow()
    vi.stubGlobal('window', undefined)
    vi.resetModules()
    const ssr = (await import('./submission-intent')).getSubmissionIntentStore
    expect(ssr()).not.toBe(ssr())
    await expect(ssr().reserve(ctx, signer, 'transfer')).rejects.toThrow()
  })
})
