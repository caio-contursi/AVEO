import { getAddressDecoder } from '@solana/kit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AveoSasHookBackend } from './backend'
import type { ApiContext } from './context'
import { PlanBlockedError } from './transactions'

const mocks = vi.hoisted(() => ({ inspect: vi.fn(), plan: vi.fn(), read: vi.fn(), confirm: vi.fn(), send: vi.fn() }))
vi.mock('./eligibility', () => ({ inspectEligibility: mocks.inspect }))
vi.mock('./accounts', () => ({ readAccount: mocks.read }))
vi.mock('./transactions', async (original) => ({ ...await original<typeof import('./transactions')>(),
  planRequest: mocks.plan, confirmSignature: mocks.confirm, signAndSend: mocks.send,
}))

const decoder = getAddressDecoder()
const mint = decoder.decode(new Uint8Array(32).fill(1))
const wallet = decoder.decode(new Uint8Array(32).fill(2))
const destination = decoder.decode(new Uint8Array(32).fill(3))
const transfer = { cluster: 'localnet' as const, mint, sourceOwner: wallet, destinationOwner: destination, amount: 1n }
const renewal = { cluster: 'localnet' as const, mint, wallet, attestation: destination }
const policy = { mint, authority: wallet, args: { proofDomain: new Uint8Array(32), pairs: [], active: true, requireKyc: true, requireAccredited: false } }

function setup() {
  const ctx = { cluster: 'localnet', commitment: 'confirmed', rpcUrl: 'http://127.0.0.1:8899', programId: wallet,
    deployment: { assets: [{ mint, decimals: 0 }] }, rpc: {} } as unknown as ApiContext
  return { ctx, backend: new AveoSasHookBackend(ctx), controller: new AbortController() }
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.inspect.mockResolvedValue({ wallet, mint, verdict: 'unknown', reasons: [], sourceAccounts: {} })
  mocks.plan.mockResolvedValue({ simulation: { ok: true, logs: [] }, transaction: 'unsigned' })
  mocks.confirm.mockResolvedValue({ status: 'unknown', logs: [] })
})

describe('read-only backend cancellation', () => {
  it.each(['transfer', 'renewal', 'policy', 'inspection'] as const)('rejects pre-aborted %s without starting reads', async (kind) => {
    const { backend, controller } = setup()
    controller.abort(new Error('private endpoint'))
    const result = kind === 'transfer' ? backend.planTransfer(transfer, controller.signal)
      : kind === 'renewal' ? backend.planRenewBinding(renewal, controller.signal)
        : kind === 'policy' ? backend.planUpdatePolicy(policy, controller.signal)
          : backend.inspect({ cluster: 'localnet', mint, wallet }, controller.signal)
    await expect(result).rejects.toMatchObject({ name: 'AbortError', message: 'Read cancelled.' })
    expect(mocks.inspect).not.toHaveBeenCalled()
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.plan).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('passes a cloned context through diagnostics and planning without mutating the execution context', async () => {
    const { backend, ctx, controller } = setup()
    await expect(backend.planTransfer(transfer, controller.signal)).resolves.toMatchObject({ transaction: 'unsigned' })
    const planningContext = mocks.plan.mock.calls[0]![0] as ApiContext
    expect(planningContext).not.toBe(ctx)
    expect(planningContext).toEqual({ ...ctx, readAbortSignal: controller.signal })
    for (const call of mocks.inspect.mock.calls) expect(call[0]).toBe(planningContext)
    expect(ctx.readAbortSignal).toBeUndefined()
    controller.abort()
    await expect(backend.verifyOutcome({ cluster: 'localnet', signature: 'original-signature', plan: await backend.planTransfer(transfer) })).resolves.toMatchObject({ status: 'unknown' })
    expect(mocks.confirm).toHaveBeenCalledWith(ctx, 'original-signature')
    expect(mocks.plan.mock.calls.at(-1)![0]).toBe(ctx)
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it.each(['transfer', 'renewal', 'policy'] as const)('settles cancelled %s even if a read ignores its signal', async (kind) => {
    const { backend, controller } = setup()
    let rejectRead!: (error: Error) => void
    const pending = new Promise<never>((_, reject) => { rejectRead = reject })
    if (kind === 'renewal') mocks.read.mockReturnValue(pending)
    else mocks.inspect.mockReturnValue(pending)
    const result = kind === 'transfer' ? backend.planTransfer(transfer, controller.signal)
      : kind === 'renewal' ? backend.planRenewBinding(renewal, controller.signal) : backend.planUpdatePolicy(policy, controller.signal)
    controller.abort('private abort reason')
    await expect(result).rejects.toMatchObject({ name: 'AbortError', message: 'Read cancelled.' })
    rejectRead(new Error('late private transport error'))
    await Promise.resolve()
    expect(mocks.plan).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('does not publish a blocked plan when cancellation races a resolver error', async () => {
    const { backend, controller } = setup()
    mocks.plan.mockImplementation(() => {
      controller.abort('private reason')
      throw new PlanBlockedError({ code: 'MissingExtraAccounts', message: 'private resolver error' })
    })
    await expect(backend.planTransfer(transfer, controller.signal)).rejects.toMatchObject({ name: 'AbortError', message: 'Read cancelled.' })
    expect(mocks.send).not.toHaveBeenCalled()
  })
})
