import { appendTransactionMessageInstruction, blockhash, compileTransaction, createTransactionMessage, getAddressDecoder, getBase58Decoder, getBase64EncodedWireTransaction, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, type SignatureBytes } from '@solana/kit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiContext } from '../../api/context'
import { messageFingerprint } from '../../api/submission-proof'
import { SubmissionIntentStore, SUBMISSION_INTENT_STORAGE_KEY, type SubmissionIntentCoordination } from './submission-intent'
import { recoverPendingSubmission } from './submission-recovery'

async function fixture(options: { signatureless?: boolean; reserved?: boolean; failed?: boolean } = {}) {
  const wallet = getAddressDecoder().decode(new Uint8Array(32).fill(2))
  const program = getAddressDecoder().decode(new Uint8Array(32).fill(5))
  const message = appendTransactionMessageInstruction({ programAddress: program, data: new Uint8Array([1]) },
    setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(program), lastValidBlockHeight: 99n },
      setTransactionMessageFeePayer(wallet, createTransactionMessage({ version: 0 }))))
  const unsigned = compileTransaction(message)
  const signatureBytes = new Uint8Array(64).fill(3) as SignatureBytes
  const signature = getBase58Decoder().decode(signatureBytes)
  const transaction = { ...unsigned, signatures: { [wallet]: signatureBytes } }
  const result = { slot: 42n, meta: { err: options.failed ? { InstructionError: [0, 'InvalidAccountData'] } : null }, transaction: [getBase64EncodedWireTransaction(transaction), 'base64'] }
  const send = vi.fn().mockResolvedValue(result)
  const rpc = { getTransaction: vi.fn(() => ({ send })), sendTransaction: vi.fn() }
  const ctx = { cluster: 'localnet', rpcUrl: 'http://127.0.0.1:8899', programId: program, commitment: 'confirmed', deployment: { generatedAt: '2026-10-11T00:00:00Z', extra: { label: 'original' } }, rpc } as unknown as ApiContext
  let raw: string | null = null
  const storage = { getItem: vi.fn(() => raw), setItem: vi.fn((_key: string, value: string) => { raw = value }) }
  let tail = Promise.resolve()
  const coordinate: SubmissionIntentCoordination = (operation) => {
    const next = tail.then(operation)
    tail = next.catch(() => {})
    return next
  }
  const store = new SubmissionIntentStore(storage, coordinate)
  const attempt = await store.reserve(ctx, wallet, 'transfer')
  if (!options.reserved) {
    await store.startWallet(attempt, await messageFingerprint(transaction.messageBytes))
    if (!options.signatureless) await store.attachSignature(attempt, signature)
  }
  storage.setItem.mockClear()
  return { ctx, store, rpc, send, signature, transaction, result, storage, coordinate, attempt, raw: () => raw, replace: (value: string | null) => { raw = value } }
}

afterEach(() => vi.useRealTimers())

describe('explicit original-message recovery', () => {
  it.each(['attachment', 'settlement'] as const)('preserves a record replaced by the %s freshness callback', async (stage) => {
    const f = await fixture({ signatureless: stage === 'attachment' })
    const replacement = JSON.stringify({ ...JSON.parse(f.raw()!), attemptId: globalThis.crypto.randomUUID() })
    let checks = 0
    const current = () => {
      if (++checks === 2) f.replace(replacement)
      return true
    }
    const operation = stage === 'attachment'
      ? f.store.attachSignature(f.attempt, f.signature, current)
      : f.store.settle(f.ctx, f.attempt, { signature: f.signature, status: 'confirmed', slot: 42, verifiedMessageFingerprint: await messageFingerprint(f.transaction.messageBytes) }, current)
    await expect(operation).rejects.toMatchObject({ code: 'record-replaced' })
    expect(f.raw()).toBe(replacement)
    expect(f.storage.setItem).not.toHaveBeenCalled()
  })
  it.each([false, true])('recovers a known signature with terminal failure=%s and enables a fresh reservation', async (failed) => {
    const f = await fixture({ failed })
    expect(await recoverPendingSubmission(f.ctx, { store: f.store })).toEqual({ status: failed ? 'failed' : 'confirmed', signature: f.signature, slot: 42 })
    expect(f.store.getSnapshot().intent).toBeUndefined()
    expect(await f.store.reserve(f.ctx, f.attempt.signer, 'transfer')).toMatchObject({ phase: 'reserved' })
    expect(f.rpc.sendTransaction).not.toHaveBeenCalled()
  })

  it.each([false, true])('validates a wallet-history candidate before attaching it, terminal failure=%s', async (failed) => {
    const f = await fixture({ signatureless: true, failed })
    f.send.mockImplementationOnce(async () => {
      expect(JSON.parse(f.raw()!).signature).toBeUndefined()
      expect(f.storage.setItem).not.toHaveBeenCalled()
      return f.result
    })
    const reopened = new SubmissionIntentStore(f.storage, f.coordinate)
    expect(await recoverPendingSubmission(f.ctx, { store: reopened, signature: f.signature })).toMatchObject({ status: failed ? 'failed' : 'confirmed', signature: f.signature })
    expect(f.storage.setItem.mock.calls.map(([, raw]) => raw === 'null' ? null : JSON.parse(raw).signature)).toEqual([f.signature, null])
    expect(f.rpc.sendTransaction).not.toHaveBeenCalled()
  })

  it.each(['cluster', 'rpcUrl', 'programId', 'commitment', 'deployment'] as const)('rejects a changed %s before RPC', async (field) => {
    const f = await fixture()
    const changed = { ...f.ctx, deployment: structuredClone(f.ctx.deployment) }
    if (field === 'cluster') changed.cluster = 'devnet'
    if (field === 'rpcUrl') changed.rpcUrl = 'https://other.invalid/?key=private'
    if (field === 'programId') changed.programId = getAddressDecoder().decode(new Uint8Array(32).fill(6))
    if (field === 'commitment') changed.commitment = 'finalized'
    if (field === 'deployment') changed.deployment.generatedAt = '2026-10-12T00:00:00Z'
    expect(await recoverPendingSubmission(changed, { store: f.store })).toEqual({ status: 'context-mismatch' })
    expect(f.rpc.getTransaction).not.toHaveBeenCalled()
    expect(f.storage.setItem).not.toHaveBeenCalled()
    expect(f.store.getSnapshot().intent?.signature).toBe(f.signature)
  })

  it.each(['invalid', 'oversized', 'different-known'] as const)('rejects %s signatures without RPC', async (mode) => {
    const f = await fixture()
    const signature = mode === 'invalid' ? 'invalid' : mode === 'oversized' ? 'x'.repeat(89) : getBase58Decoder().decode(new Uint8Array(64).fill(7))
    expect(await recoverPendingSubmission(f.ctx, { store: f.store, signature })).toEqual({ status: 'invalid-signature' })
    expect(f.rpc.getTransaction).not.toHaveBeenCalled()
    expect(f.storage.setItem).not.toHaveBeenCalled()
  })

  it.each(['different-signature', 'different-message', 'missing', 'malformed'] as const)('does not poison a signatureless intent with %s evidence', async (mode) => {
    const f = await fixture({ signatureless: true })
    const original = f.raw()
    let candidate = f.signature
    if (mode === 'different-signature') candidate = getBase58Decoder().decode(new Uint8Array(64).fill(7))
    if (mode === 'different-message') {
      // Deliberately corrupt encoded bytes; this is not a valid SDK-produced message.
      const altered = { ...f.transaction, messageBytes: new Uint8Array([...f.transaction.messageBytes.slice(0, -1), 99]) as unknown as typeof f.transaction.messageBytes }
      f.send.mockResolvedValueOnce({ ...f.result, transaction: [getBase64EncodedWireTransaction(altered), 'base64'] })
    }
    if (mode === 'missing') f.send.mockResolvedValueOnce(null)
    if (mode === 'malformed') f.send.mockResolvedValueOnce({ ...f.result, transaction: ['invalid', 'base64'] })
    expect(await recoverPendingSubmission(f.ctx, { store: f.store, signature: candidate })).toEqual({ status: 'unknown', signature: candidate })
    expect(f.raw()).toBe(original)
    expect(f.storage.setItem).not.toHaveBeenCalled()
    expect(f.rpc.sendTransaction).not.toHaveBeenCalled()
  })

  it('bounds unavailable history without attaching a candidate', async () => {
    const f = await fixture({ signatureless: true })
    f.send.mockImplementationOnce(() => new Promise(() => {}))
    vi.useFakeTimers()
    const recovery = recoverPendingSubmission(f.ctx, { store: f.store, signature: f.signature })
    await vi.advanceTimersByTimeAsync(0)
    // WebCrypto hashing completes outside fake timers; wait until the RPC boundary exists.
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await recovery).toEqual({ status: 'unknown', signature: f.signature })
    expect(f.storage.setItem).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retries the original signature retained after a failed durable write', async () => {
    const f = await fixture({ signatureless: true })
    f.storage.setItem.mockImplementationOnce(() => { throw new DOMException('private endpoint details', 'QuotaExceededError') })
    await expect(f.store.attachSignature(f.attempt, f.signature)).rejects.toThrow()
    expect(JSON.parse(f.raw()!).signature).toBeUndefined()
    expect(await recoverPendingSubmission(f.ctx, { store: f.store })).toMatchObject({ status: 'confirmed', signature: f.signature })
    expect(f.store.getSnapshot().intent).toBeUndefined()
  })

  it.each(['attachment', 'settlement'] as const)('never reports success after %s storage failure', async (stage) => {
    const f = await fixture({ signatureless: stage === 'attachment' })
    f.storage.setItem.mockImplementation(() => { throw new Error('https://private.invalid/?key=secret') })
    expect(await recoverPendingSubmission(f.ctx, { store: f.store, signature: f.signature })).toEqual({ status: 'blocked' })
    expect(f.store.getSnapshot().intent?.phase).toBe('wallet-invoked')
    await expect(f.store.reserve(f.ctx, f.attempt.signer, 'transfer')).rejects.toThrow()
    expect(f.rpc.sendTransaction).not.toHaveBeenCalled()
  })

  it('does not cancel or query a reloaded pre-wallet reservation', async () => {
    const f = await fixture({ reserved: true })
    const reopened = new SubmissionIntentStore(f.storage, f.coordinate)
    expect(await recoverPendingSubmission(f.ctx, { store: reopened, signature: f.signature })).toEqual({ status: 'blocked' })
    expect(f.rpc.getTransaction).not.toHaveBeenCalled()
    expect(f.storage.setItem).not.toHaveBeenCalled()
  })

  it.each(['caller', 'context', 'replacement', 'removal'] as const)('retains the blocker when %s changes during proof verification', async (mode) => {
    const f = await fixture({ signatureless: true })
    let active = true
    f.send.mockImplementationOnce(async () => {
      if (mode === 'caller') active = false
      if (mode === 'context') f.ctx.rpcUrl = 'https://different.invalid'
      if (mode === 'replacement') f.replace(JSON.stringify({ ...JSON.parse(f.raw()!), messageFingerprint: 'a'.repeat(64) }))
      if (mode === 'removal') f.replace(null)
      return f.result
    })
    const result = await recoverPendingSubmission(f.ctx, { store: f.store, signature: f.signature, isCurrent: () => active })
    expect(result.status).toBe(mode === 'caller' || mode === 'context' ? 'stale' : 'blocked')
    expect(f.storage.setItem).not.toHaveBeenCalled()
    expect(f.rpc.sendTransaction).not.toHaveBeenCalled()
  })

  it('returns stale without RPC if already inactive', async () => {
    const f = await fixture()
    expect(await recoverPendingSubmission(f.ctx, { store: f.store, isCurrent: () => false })).toEqual({ status: 'stale' })
    expect(f.rpc.getTransaction).not.toHaveBeenCalled()
  })

  it('preserves a replacement created by a signature notification instead of clearing it', async () => {
    const f = await fixture({ signatureless: true })
    const replacement = { ...JSON.parse(f.raw()!), attemptId: globalThis.crypto.randomUUID() }
    let replaced = false
    f.store.subscribe(() => {
      if (!replaced && f.store.getSnapshot().intent?.signature === f.signature) {
        // A successful signature notification occurs only after its durable write.
        expect(JSON.parse(f.raw()!).signature).toBe(f.signature)
        replaced = true
        f.replace(JSON.stringify(replacement))
      }
    })
    expect(await recoverPendingSubmission(f.ctx, { store: f.store, signature: f.signature })).toEqual({ status: 'blocked' })
    expect(JSON.parse(f.raw()!)).toEqual(replacement)
    expect(f.storage.setItem.mock.calls.some(([, raw]) => raw === 'null')).toBe(false)
  })

  it('retains a verified signature without settlement when notification invalidates the view', async () => {
    const f = await fixture({ signatureless: true })
    let active = true
    f.store.subscribe(() => {
      if (f.store.getSnapshot().intent?.signature) active = false
    })
    expect(await recoverPendingSubmission(f.ctx, { store: f.store, signature: f.signature, isCurrent: () => active })).toEqual({ status: 'stale' })
    expect(JSON.parse(f.raw()!).signature).toBe(f.signature)
    expect(f.storage.setItem.mock.calls.some(([, raw]) => raw === 'null')).toBe(false)
  })

  it('does not trust a successful settlement write without matching read-back', async () => {
    const f = await fixture()
    f.storage.setItem.mockImplementation(() => {})
    expect(await recoverPendingSubmission(f.ctx, { store: f.store })).toEqual({ status: 'blocked' })
    expect(f.store.getSnapshot().intent?.signature).toBe(f.signature)
    await expect(f.store.reserve(f.ctx, f.attempt.signer, 'transfer')).rejects.toThrow()
  })

  it('rechecks view ownership inside the settlement lock after signature attachment', async () => {
    const f = await fixture({ signatureless: true })
    let active = true
    const settle = f.store.settle.bind(f.store)
    vi.spyOn(f.store, 'settle').mockImplementationOnce(async (...args) => {
      active = false
      await settle(...args)
    })
    expect(await recoverPendingSubmission(f.ctx, { store: f.store, signature: f.signature, isCurrent: () => active })).toEqual({ status: 'stale' })
    expect(JSON.parse(f.raw()!).signature).toBe(f.signature)
    expect(f.storage.setItem.mock.calls.some(([, raw]) => raw === 'null')).toBe(false)
  })

  it('does not overwrite a late conflicting wallet signature during candidate verification', async () => {
    const f = await fixture({ signatureless: true })
    const other = getBase58Decoder().decode(new Uint8Array(64).fill(7))
    f.send.mockImplementationOnce(async () => {
      await f.store.attachSignature(f.attempt, other)
      return f.result
    })
    expect(await recoverPendingSubmission(f.ctx, { store: f.store, signature: f.signature })).toEqual({ status: 'blocked' })
    expect(JSON.parse(f.raw()!).signature).toBe(other)
    expect(f.storage.setItem.mock.calls.some(([, raw]) => raw === 'null')).toBe(false)
  })

  it('fails closed for unavailable storage and malformed records', async () => {
    const f = await fixture()
    const unavailable = new SubmissionIntentStore(undefined, f.coordinate)
    expect(await recoverPendingSubmission(f.ctx, { store: unavailable })).toEqual({ status: 'blocked' })
    f.replace('{')
    const malformed = new SubmissionIntentStore(f.storage, f.coordinate)
    expect(await recoverPendingSubmission(f.ctx, { store: malformed })).toEqual({ status: 'blocked' })
    expect(f.rpc.getTransaction).not.toHaveBeenCalled()
    expect(f.storage.setItem).not.toHaveBeenCalled()
  })

  it('returns empty without network when there is no pending operation', async () => {
    const f = await fixture()
    f.replace(null)
    const empty = new SubmissionIntentStore(f.storage, f.coordinate)
    expect(await recoverPendingSubmission(f.ctx, { store: empty })).toEqual({ status: 'empty' })
    expect(f.rpc.getTransaction).not.toHaveBeenCalled()
    expect(f.storage.getItem).toHaveBeenCalledWith(SUBMISSION_INTENT_STORAGE_KEY)
  })
})
