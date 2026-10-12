import { appendTransactionMessageInstruction, blockhash, compileTransaction, createTransactionMessage, getAddressDecoder, getBase58Decoder, getBase64EncodedWireTransaction, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, type Signature, type SignatureBytes, type TransactionSigner } from '@solana/kit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeskPlan } from '../../api/backend'
import type { ApiContext } from '../../api/context'
import { signAndSend, SubmissionUnknownError } from '../../api/transactions'
import { messageFingerprint } from '../../api/submission-proof'
import { reconcileSubmissionIntent, runPlan } from './execution'
import { SubmissionIntentStore, type SubmissionIntentCoordination } from './submission-intent'

vi.mock('../../api/transactions', async (original) => ({ ...await original<typeof import('../../api/transactions')>(), signAndSend: vi.fn() }))

const wallet = getAddressDecoder().decode(new Uint8Array(32).fill(2))
const signature = getBase58Decoder().decode(new Uint8Array(64).fill(3)) as Signature
const hash = 'a'.repeat(64)
const ctx = { cluster: 'localnet', rpcUrl: 'http://127.0.0.1:8899', programId: wallet, commitment: 'confirmed', deployment: { generatedAt: '2026-10-11T00:00:00Z' } } as unknown as ApiContext
const signer = { address: wallet } as TransactionSigner
const plan = { request: { kind: 'transfer' }, simulation: { unitsConsumed: 42 }, diagnostics: { source: { reasons: [] }, destination: { reasons: [] } } } as unknown as DeskPlan

function storageAndLock() {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
  let tail = Promise.resolve()
  const coordinate: SubmissionIntentCoordination = (operation) => {
    const next = tail.then(operation)
    tail = next.catch(() => {})
    return next
  }
  return { storage, coordinate }
}

beforeEach(() => vi.resetAllMocks())

describe('central execution durable gate', () => {
  it('does not accept an empty originating store as evidence for an active attempt', async () => {
    const f = storageAndLock()
    const store = new SubmissionIntentStore(f.storage, f.coordinate)
    const getTransaction = vi.fn()
    const originalContext = { ...ctx, rpc: { getTransaction } } as unknown as ApiContext
    expect(await reconcileSubmissionIntent(originalContext, signature, store, 'required-attempt')).toBe(false)
    expect(getTransaction).not.toHaveBeenCalled()
  })

  it.each(['context', 'signature'] as const)('rejects a different %s in central reconciliation before RPC', async (change) => {
    const f = storageAndLock()
    const store = new SubmissionIntentStore(f.storage, f.coordinate)
    const attempt = await store.reserve(ctx, wallet, 'transfer')
    await store.startWallet(attempt, hash)
    await store.attachSignature(attempt, signature)
    const getTransaction = vi.fn()
    const originalContext = { ...ctx, rpc: { getTransaction }, ...(change === 'context' ? { rpcUrl: 'https://different.invalid' } : {}) } as unknown as ApiContext
    const candidate = change === 'signature' ? getBase58Decoder().decode(new Uint8Array(64).fill(7)) : signature
    expect(await reconcileSubmissionIntent(originalContext, candidate, store, attempt.attemptId)).toBe(false)
    expect(getTransaction).not.toHaveBeenCalled()
    expect(store.getSnapshot().intent?.signature).toBe(signature)
  })
  it.each([true, false])('releases only when fresh wire evidence matches the reserved message: %s', async (matching) => {
    const f = storageAndLock()
    const store = new SubmissionIntentStore(f.storage, f.coordinate)
    const program = getAddressDecoder().decode(new Uint8Array(32).fill(5))
    const message = appendTransactionMessageInstruction({ programAddress: program, data: new Uint8Array([1]) },
      setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(program), lastValidBlockHeight: 99n },
        setTransactionMessageFeePayer(wallet, createTransactionMessage({ version: 0 }))))
    const unsigned = compileTransaction(message)
    const signed = { ...unsigned, signatures: { [wallet]: new Uint8Array(64).fill(3) as SignatureBytes } }
    const expectedHash = await messageFingerprint(signed.messageBytes)
    const send = vi.fn().mockResolvedValue({ slot: 42n, meta: { err: null }, transaction: [getBase64EncodedWireTransaction(signed), 'base64'] })
    const originalContext = { ...ctx, rpc: { getTransaction: vi.fn(() => ({ send })) } } as unknown as ApiContext
    vi.mocked(signAndSend).mockImplementationOnce(async (_ctx, _request, _signer, _units, onSent, beforeWallet, persistSignature) => {
      await beforeWallet!(matching ? expectedHash : hash)
      onSent!(signature)
      await persistSignature!(signature)
      expect(store.getSnapshot().intent?.signature).toBe(signature)
      return signature
    })
    const backend = { verifyOutcome: vi.fn().mockResolvedValue({ status: 'confirmed', signature, logs: [] }) }
    expect(await runPlan(originalContext, backend, signer, plan, { intentStore: store })).toMatchObject({ signature, evidence: { status: matching ? 'confirmed' : 'unknown' } })
    expect(send).toHaveBeenCalledTimes(1)
    if (matching) {
      expect(store.getSnapshot().intent).toBeUndefined()
      expect(await store.reserve(originalContext, wallet, 'transfer')).toMatchObject({ phase: 'reserved' })
    } else {
      expect(store.getSnapshot().intent?.signature).toBe(signature)
      await expect(store.reserve(originalContext, wallet, 'transfer')).rejects.toMatchObject({ code: 'unresolved-intent' })
    }
  })
  it('never calls a wallet when durable storage is unavailable', async () => {
    const store = new SubmissionIntentStore(undefined, async (operation) => { await operation() })
    const backend = { verifyOutcome: vi.fn() }
    expect(await runPlan(ctx, backend, signer, plan, { intentStore: store })).toMatchObject({ sendBlocked: true, error: { code: 'ConfirmationUnknown' } })
    expect(signAndSend).not.toHaveBeenCalled()
    expect(backend.verifyOutcome).not.toHaveBeenCalled()
  })

  it('preserves signatureless ambiguity across new instances and prevents another wallet invocation', async () => {
    const f = storageAndLock()
    const store = new SubmissionIntentStore(f.storage, f.coordinate)
    vi.mocked(signAndSend).mockImplementationOnce(async (_ctx, _request, _signer, _units, _onSent, beforeWallet) => {
      await beforeWallet!(hash)
      expect(store.getSnapshot().intent?.phase).toBe('wallet-invoked')
      throw new SubmissionUnknownError(new Error('Wallet response lost'))
    })
    const backend = { verifyOutcome: vi.fn() }
    expect(await runPlan(ctx, backend, signer, plan, { intentStore: store })).toMatchObject({ sendBlocked: true })
    const reloaded = new SubmissionIntentStore(f.storage, f.coordinate)
    expect(await runPlan(ctx, backend, signer, plan, { intentStore: reloaded })).toMatchObject({ sendBlocked: true })
    expect(signAndSend).toHaveBeenCalledTimes(1)
    expect(reloaded.getSnapshot().intent).toMatchObject({ phase: 'wallet-invoked', messageFingerprint: hash })
  })

  it('cancels only a proven pre-wallet build failure and permits a subsequent reservation', async () => {
    const f = storageAndLock()
    const store = new SubmissionIntentStore(f.storage, f.coordinate)
    vi.mocked(signAndSend).mockRejectedValueOnce(new Error('Instruction preparation failed'))
    const backend = { verifyOutcome: vi.fn() }
    expect(await runPlan(ctx, backend, signer, plan, { intentStore: store })).toMatchObject({ error: { code: 'SimulationFailed' } })
    expect(store.getSnapshot().intent).toBeUndefined()
    expect(await store.reserve(ctx, wallet, 'transfer')).toMatchObject({ phase: 'reserved' })
  })

  it('retains the original signature and blocker when a returned signature conflicts with the callback', async () => {
    const f = storageAndLock()
    const store = new SubmissionIntentStore(f.storage, f.coordinate)
    const other = getBase58Decoder().decode(new Uint8Array(64).fill(4)) as Signature
    vi.mocked(signAndSend).mockImplementationOnce(async (_ctx, _request, _signer, _units, onSent, beforeWallet) => {
      await beforeWallet!(hash)
      onSent!(signature)
      return other
    })
    const backend = { verifyOutcome: vi.fn() }
    expect(await runPlan(ctx, backend, signer, plan, { intentStore: store })).toMatchObject({ signature, evidence: { status: 'unknown', signature } })
    expect(store.getSnapshot().intent?.signature).toBe(signature)
    expect(backend.verifyOutcome).not.toHaveBeenCalled()
  })
})
