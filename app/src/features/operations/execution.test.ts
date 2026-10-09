import type { Signature, TransactionSigner } from '@solana/kit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeskEvidence, DeskPlan } from '../../api/backend'
import type { ApiContext } from '../../api/context'
import { signAndSend } from '../../api/transactions'
import { PlanExecution, runPlan } from './execution'
import { labelFor } from './labels'

vi.mock('../../api/transactions', () => ({ signAndSend: vi.fn() }))

const signature = 'original-signature' as Signature
const ctx = {
  cluster: 'localnet', rpcUrl: 'http://original-rpc', programId: 'original-program',
  commitment: 'confirmed', deployment: { version: 1 },
} as unknown as ApiContext
const signer = {} as TransactionSigner
const plan = {
  request: { kind: 'transfer', amount: 1n }, simulation: { ok: true, unitsConsumed: 42 },
  diagnostics: { source: { reasons: [] }, destination: { reasons: [] } },
} as unknown as DeskPlan
const unknown: DeskEvidence = { status: 'unknown', signature, logs: [] }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

function setup() {
  const publish = vi.fn()
  const execution = new PlanExecution(publish)
  const backend = { verifyOutcome: vi.fn().mockResolvedValue(unknown) }
  return { publish, execution, backend }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(signAndSend).mockResolvedValue(signature)
})

describe('runPlan and retained recheck', () => {
  it('records the returned signature once before verification', async () => {
    const record = vi.fn(() => expect(backend.verifyOutcome).not.toHaveBeenCalled())
    const execution = new PlanExecution(vi.fn(), record)
    const backend = { verifyOutcome: vi.fn().mockResolvedValue(unknown) }
    await execution.execute(ctx, backend, signer, plan)
    expect(record).toHaveBeenCalledExactlyOnceWith(ctx, signature)
    await execution.recheck(ctx)
    expect(record).toHaveBeenCalledTimes(1)
    expect(signAndSend).toHaveBeenCalledTimes(1)
  })

  it('records a late signature in its original context even after navigation', async () => {
    const record = vi.fn(), publish = vi.fn()
    const execution = new PlanExecution(publish, record)
    const backend = { verifyOutcome: vi.fn().mockResolvedValue(unknown) }
    const sending = deferred<Signature>()
    vi.mocked(signAndSend).mockReturnValueOnce(sending.promise)
    const result = execution.execute(ctx, backend, signer, plan)
    execution.deactivate()
    const count = publish.mock.calls.length
    sending.resolve(signature)
    expect(await result).toBeUndefined()
    expect(record).toHaveBeenCalledExactlyOnceWith(ctx, signature)
    expect(publish).toHaveBeenCalledTimes(count)
    expect(signAndSend).toHaveBeenCalledTimes(1)
  })

  it('still verifies an already submitted transaction when receipt recording throws', async () => {
    const record = vi.fn(() => { throw new Error('Storage unavailable') })
    const execution = new PlanExecution(vi.fn(), record)
    const backend = { verifyOutcome: vi.fn().mockResolvedValue(unknown) }
    expect(await execution.execute(ctx, backend, signer, plan)).toEqual(unknown)
    expect(execution.state.phase).toBe('done')
    expect(backend.verifyOutcome).toHaveBeenCalledTimes(1)
    expect(signAndSend).toHaveBeenCalledTimes(1)
  })
  it.each(['confirmed', 'failed'] as const)('moves unknown to %s without signing again, retaining the original inputs', async (status) => {
    const { execution, backend } = setup()
    const balancesBefore = [10n, 20n]
    await execution.execute(ctx, backend, signer, plan, { balancesBefore })
    balancesBefore[0] = 999n
    const replacement = { verifyOutcome: vi.fn() }
    const next: DeskEvidence = { status, signature, logs: ['original logs'], slot: 123 }
    backend.verifyOutcome.mockResolvedValue(next)
    // Recheck has no wallet/signer parameter and never receives a replacement backend or plan.
    expect(await execution.recheck({ ...ctx })).toEqual(next)
    expect(backend.verifyOutcome).toHaveBeenCalledTimes(2)
    for (const [input] of backend.verifyOutcome.mock.calls) {
      expect(input).toEqual({ cluster: ctx.cluster, plan, signature, balancesBefore: [10n, 20n] })
      expect(input.plan).toBe(plan)
    }
    expect(replacement.verifyOutcome).not.toHaveBeenCalled()
    expect(signAndSend).toHaveBeenCalledExactlyOnceWith(ctx, plan.request, signer, 42)
    expect(await execution.recheck(ctx)).toBeUndefined()
    expect(backend.verifyOutcome).toHaveBeenCalledTimes(2)
  })

  it('keeps initial verification and recheck exceptions unknown with the same signature', async () => {
    const { execution, backend } = setup()
    backend.verifyOutcome.mockRejectedValue(new Error('RPC unavailable'))
    expect(await execution.execute(ctx, backend, signer, plan)).toMatchObject({ status: 'unknown', signature })
    expect(await execution.recheck(ctx)).toMatchObject({ status: 'unknown', signature, error: { code: 'ConfirmationUnknown', message: 'RPC unavailable' } })
    expect(execution.state).toMatchObject({ phase: 'done', signature, evidence: { status: 'unknown', signature } })
    expect(signAndSend).toHaveBeenCalledTimes(1)
  })

  it('calls onSent once before verification in the actual runPlan path', async () => {
    const { backend } = setup()
    const onSent = vi.fn(() => expect(backend.verifyOutcome).not.toHaveBeenCalled())
    expect(await runPlan(ctx, backend, signer, plan, { onSent })).toEqual({ signature, evidence: unknown })
    expect(onSent).toHaveBeenCalledExactlyOnceWith(signature)
  })

  it('does not verify a rejected send and allows a deliberate retry after reset', async () => {
    const { execution, backend } = setup()
    vi.mocked(signAndSend).mockRejectedValueOnce(new Error('Wallet rejected'))
    expect(await execution.execute(ctx, backend, signer, plan)).toBeUndefined()
    expect(execution.state).toMatchObject({ phase: 'error', error: { code: 'SimulationFailed' } })
    expect(backend.verifyOutcome).not.toHaveBeenCalled()
    expect(execution.reset()).toBe(true)
    await execution.execute(ctx, backend, signer, plan)
    expect(signAndSend).toHaveBeenCalledTimes(2)
  })
})

describe('execution guards and context transitions', () => {
  it('retains original evidence labels and transfer decimals across edited plans and context swaps', async () => {
    const { execution, backend } = setup()
    const originalCtx = {
      ...ctx,
      deployment: { ...ctx.deployment, wallets: [], verifiers: [], assets: [{ mint: 'original-mint', label: 'Original asset', decimals: 6 }] },
    } as unknown as ApiContext
    const originalPlan = { ...plan, request: { ...plan.request, mint: 'original-mint', decimals: 6 } } as DeskPlan
    expect(execution.displayMetadata).toBeUndefined()
    await execution.execute(originalCtx, backend, signer, originalPlan)
    const changedCtx = {
      ...originalCtx, rpcUrl: 'http://new-rpc',
      deployment: { ...originalCtx.deployment, assets: [{ mint: 'original-mint', label: 'Changed label', decimals: 9 }] },
    } as unknown as ApiContext
    const editedPlan = { ...originalPlan, request: { ...originalPlan.request, mint: 'other-mint', decimals: 9 } } as DeskPlan
    expect(execution.reset()).toBe(false)
    expect(await execution.execute(changedCtx, backend, signer, editedPlan)).toBeUndefined()
    expect(execution.matchesContext(changedCtx)).toBe(false)
    expect(execution.displayMetadata?.deployment).toBe(originalCtx.deployment)
    expect(execution.displayMetadata?.decimals).toBe(6)
    expect(labelFor(execution.displayMetadata!.deployment, 'original-mint')).toBe('Original asset')
    execution.setContext(originalCtx)
    backend.verifyOutcome.mockResolvedValue({ status: 'confirmed', signature, logs: [] })
    await execution.recheck(originalCtx)
    expect(execution.displayMetadata?.deployment).toBe(originalCtx.deployment)
    expect(execution.displayMetadata?.decimals).toBe(6)
    expect(backend.verifyOutcome.mock.calls[1][0].plan).toBe(originalPlan)
    expect(signAndSend).toHaveBeenCalledTimes(1)
    expect(execution.reset()).toBe(true)
    expect(execution.displayMetadata).toBeUndefined()
  })

  it('blocks concurrent sends, reset during signing, and edited plans after unknown', async () => {
    const { execution, backend } = setup()
    const sending = deferred<Signature>()
    vi.mocked(signAndSend).mockReturnValueOnce(sending.promise)
    const first = execution.execute(ctx, backend, signer, plan)
    expect(execution.reset()).toBe(false)
    expect(await execution.execute(ctx, backend, signer, plan)).toBeUndefined()
    sending.resolve(signature)
    await first
    expect(execution.reset()).toBe(false)
    const editedPlan = { ...plan, request: { ...plan.request, amount: 100n } } as DeskPlan
    expect(await execution.execute(ctx, backend, signer, editedPlan)).toBeUndefined()
    await execution.recheck(ctx)
    expect(backend.verifyOutcome.mock.calls[1][0].plan).toBe(plan)
    expect(signAndSend).toHaveBeenCalledTimes(1)
  })

  it('blocks concurrent rechecks, resets and signing while rechecking', async () => {
    const { execution, backend } = setup()
    await execution.execute(ctx, backend, signer, plan)
    const verification = deferred<DeskEvidence>()
    backend.verifyOutcome.mockReturnValueOnce(verification.promise)
    const first = execution.recheck(ctx)
    expect(execution.state).toMatchObject({ phase: 'verifying', signature, evidence: unknown })
    expect(execution.reset()).toBe(false)
    expect(await execution.recheck(ctx)).toBeUndefined()
    expect(await execution.execute(ctx, backend, signer, plan)).toBeUndefined()
    verification.resolve({ status: 'confirmed', signature, logs: [] })
    await first
    expect(backend.verifyOutcome).toHaveBeenCalledTimes(2)
    expect(signAndSend).toHaveBeenCalledTimes(1)
    expect(execution.reset()).toBe(true)
    expect(execution.state).toEqual({ phase: 'idle' })
  })

  it.each([
    { cluster: 'devnet' }, { rpcUrl: 'http://new-rpc' }, { programId: 'new-program' },
    { commitment: 'finalized' }, { deployment: { version: 2 } },
  ])('blocks recheck on changed context %j, then uses the original backend when restored', async (patch) => {
    const { execution, backend } = setup()
    await execution.execute(ctx, backend, signer, plan)
    const changed = { ...ctx, ...patch } as ApiContext
    expect(await execution.recheck(changed)).toBeUndefined()
    expect(execution.matchesContext(changed)).toBe(false)
    expect(backend.verifyOutcome).toHaveBeenCalledTimes(1)
    await execution.recheck(ctx)
    expect(backend.verifyOutcome).toHaveBeenCalledTimes(2)
    expect(signAndSend).toHaveBeenCalledTimes(1)
  })

  it('ignores late onSent and result after context changes during signing, retaining a private send guard', async () => {
    const { execution, backend, publish } = setup()
    const sending = deferred<Signature>()
    vi.mocked(signAndSend).mockReturnValueOnce(sending.promise)
    backend.verifyOutcome.mockResolvedValue({ status: 'confirmed', signature, logs: [] })
    const first = execution.execute(ctx, backend, signer, plan)
    const changed = { ...ctx, rpcUrl: 'http://new-rpc' }
    execution.setContext(changed)
    const calls = publish.mock.calls.length
    sending.resolve(signature)
    expect(await first).toBeUndefined()
    expect(publish).toHaveBeenCalledTimes(calls)
    expect(execution.state.signature).toBeUndefined()
    expect(execution.reset()).toBe(false)
    expect(await execution.execute(changed, backend, signer, plan)).toBeUndefined()
    execution.setContext(ctx)
    expect(execution.state).toMatchObject({ evidence: { status: 'unknown', signature } })
    await execution.recheck(ctx)
    expect(signAndSend).toHaveBeenCalledTimes(1)
  })

  it.each(['initial', 'recheck'] as const)('ignores a late %s verification even after switching back to the original context', async (stage) => {
    const { execution, backend, publish } = setup()
    if (stage === 'recheck') await execution.execute(ctx, backend, signer, plan)
    const verification = deferred<DeskEvidence>()
    backend.verifyOutcome.mockReturnValueOnce(verification.promise)
    const first = stage === 'initial' ? execution.execute(ctx, backend, signer, plan) : execution.recheck(ctx)
    await Promise.resolve()
    execution.setContext({ ...ctx, cluster: 'devnet' })
    execution.setContext(ctx)
    const calls = publish.mock.calls.length
    verification.resolve({ status: 'confirmed', signature, logs: [] })
    expect(await first).toBeUndefined()
    expect(publish).toHaveBeenCalledTimes(calls)
    expect(execution.state).toMatchObject({ evidence: { status: 'unknown', signature } })
    expect(execution.reset()).toBe(false)
    await execution.recheck(ctx)
    expect(signAndSend).toHaveBeenCalledTimes(1)
  })

  it('does not publish an in-flight completion after unmount', async () => {
    const { execution, backend, publish } = setup()
    const verification = deferred<DeskEvidence>()
    backend.verifyOutcome.mockReturnValueOnce(verification.promise)
    const first = execution.execute(ctx, backend, signer, plan)
    await Promise.resolve()
    execution.deactivate()
    const calls = publish.mock.calls.length
    verification.resolve({ status: 'confirmed', signature, logs: [] })
    expect(await first).toBeUndefined()
    expect(publish).toHaveBeenCalledTimes(calls)
  })

  it('recovers with reset after a stale wallet rejection without publishing the old error', async () => {
    const { execution, backend, publish } = setup()
    let reject!: (error: Error) => void
    vi.mocked(signAndSend).mockReturnValueOnce(new Promise((_resolve, r) => { reject = r }))
    const first = execution.execute(ctx, backend, signer, plan)
    const changed = { ...ctx, rpcUrl: 'http://new-rpc' }
    execution.setContext(changed)
    const calls = publish.mock.calls.length
    reject(new Error('Wallet rejected'))
    expect(await first).toBeUndefined()
    expect(publish).toHaveBeenCalledTimes(calls)
    expect(backend.verifyOutcome).not.toHaveBeenCalled()
    expect(execution.matchesContext(changed)).toBe(true)
    expect(execution.reset()).toBe(true)
    await execution.execute(changed, backend, signer, plan)
    expect(signAndSend).toHaveBeenCalledTimes(2)
  })
})
