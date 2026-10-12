import { AccountRole, createNoopSigner, getAddressDecoder, type Address, type Instruction } from '@solana/kit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiContext } from './context'
import { buildInstructions, planRequest, simulate, type PlanRequest } from './transactions'

const mocks = vi.hoisted(() => ({
  readAccounts: vi.fn(), binding: vi.fn(), resolve: vi.fn(), tokenPda: vi.fn(),
  sign: vi.fn(), signAndSend: vi.fn(),
}))
vi.mock('./accounts', async (original) => ({
  ...await original<typeof import('./accounts')>(), readAccounts: mocks.readAccounts,
}))
vi.mock('./instructions', async (original) => ({
  ...await original<typeof import('./instructions')>(), getSetBindingInstruction: mocks.binding,
}))
vi.mock('@solana-program/token-2022', async (original) => ({
  ...await original<typeof import('@solana-program/token-2022')>(),
  findAssociatedTokenPda: mocks.tokenPda, resolveExtraAccountMetasForExecute: mocks.resolve,
}))
vi.mock('@solana/kit', async (original) => ({
  ...await original<typeof import('@solana/kit')>(),
  signTransactionMessageWithSigners: mocks.sign,
  signAndSendTransactionMessageWithSigners: mocks.signAndSend,
}))

const decoder = getAddressDecoder()
const [programId, mint, wallet, destination, sourceToken, destinationToken] =
  [1, 2, 3, 4, 5, 6].map((byte) => decoder.decode(new Uint8Array(32).fill(byte)))
const instruction: Instruction = { programAddress: programId!, accounts: [], data: new Uint8Array([1]) }
const binding: PlanRequest = {
  kind: 'set-binding', mints: [mint!], wallet: wallet!, credential: destination!,
  schema: destination!, attestation: destination!,
}
const transfer: PlanRequest = {
  kind: 'transfer', mint: mint!, sourceOwner: wallet!, destinationOwner: destination!, amount: 7n, decimals: 2,
}
const blockhashResponse = { value: { blockhash: decoder.decode(new Uint8Array(32).fill(7)), lastValidBlockHeight: 99n } }
const simulationResponse = { value: { err: null, logs: ['Program completed'], unitsConsumed: 123n } }
const cancelled = { name: 'AbortError', message: 'Read cancelled.' }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function setup(withSignal = true) {
  const controller = new AbortController()
  const blockhashSend = vi.fn().mockResolvedValue(blockhashResponse)
  const simulationSend = vi.fn().mockResolvedValue(simulationResponse)
  const accountSend = vi.fn()
  const reactiveStore = { subscribe: vi.fn() }
  const getLatestBlockhash = vi.fn(() => ({ send: blockhashSend }))
  const simulateTransaction = vi.fn(() => ({ send: simulationSend }))
  const getAccountInfo = vi.fn((_account: Address, _config?: unknown) => ({ send: accountSend, reactiveStore }))
  const sendTransaction = vi.fn(() => { throw new Error('Read-only planning must never send a transaction') })
  const ctx = {
    commitment: 'confirmed', programId,
    ...(withSignal ? { readAbortSignal: controller.signal } : {}),
    rpc: { getLatestBlockhash, simulateTransaction, getAccountInfo, sendTransaction },
  } as unknown as ApiContext
  return { ctx, controller, blockhashSend, simulationSend, accountSend, reactiveStore,
    getLatestBlockhash, simulateTransaction, getAccountInfo, sendTransaction }
}

function expectNoSubmission(rpc: ReturnType<typeof setup>) {
  expect(mocks.sign).not.toHaveBeenCalled()
  expect(mocks.signAndSend).not.toHaveBeenCalled()
  expect(rpc.sendTransaction).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.binding.mockResolvedValue(instruction)
  mocks.tokenPda.mockImplementation(({ owner }) => Promise.resolve([
    owner === wallet ? sourceToken : destinationToken, 255,
  ]))
  mocks.readAccounts.mockResolvedValue({ accounts: [{}, {}], slot: 42 })
  mocks.resolve.mockResolvedValue([{ address: programId, role: AccountRole.READONLY }])
})

describe('simulation read cancellation', () => {
  it('rejects an already cancelled simulation before any RPC', async () => {
    const rpc = setup()
    rpc.controller.abort('private reason')
    await expect(simulate(rpc.ctx, [instruction], wallet!)).rejects.toMatchObject(cancelled)
    expect(rpc.getLatestBlockhash).not.toHaveBeenCalled()
    expect(rpc.simulateTransaction).not.toHaveBeenCalled()
    expectNoSubmission(rpc)
  })

  it.each([false, true])('preserves simulation results and forwards read options with signal: %s', async (withSignal) => {
    const rpc = setup(withSignal)
    await expect(simulate(rpc.ctx, [instruction], wallet!)).resolves.toEqual({
      ok: true, logs: ['Program completed'], unitsConsumed: 123,
    })
    const options = withSignal ? { abortSignal: rpc.controller.signal } : undefined
    expect(rpc.getLatestBlockhash).toHaveBeenCalledWith({ commitment: 'confirmed' })
    expect(rpc.blockhashSend).toHaveBeenCalledWith(options)
    expect(rpc.simulationSend).toHaveBeenCalledWith(options)
    expect(rpc.simulateTransaction).toHaveBeenCalledWith(expect.any(String), {
      encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed',
    })
    expectNoSubmission(rpc)
  })

  it.each(['blockhash', 'simulation'] as const)('cancels a hanging %s read and handles late rejection', async (stage) => {
    const rpc = setup()
    const pending = deferred<never>()
    const started = deferred<void>()
    const send = stage === 'blockhash' ? rpc.blockhashSend : rpc.simulationSend
    send.mockImplementation(() => { started.resolve(); return pending.promise })
    const result = simulate(rpc.ctx, [instruction], wallet!)
    await started.promise
    expect(send).toHaveBeenCalledWith({ abortSignal: rpc.controller.signal })
    rpc.controller.abort(new Error('private reason'))
    await expect(result).rejects.toMatchObject(cancelled)
    pending.reject(new Error('late private transport error'))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(rpc.simulateTransaction).toHaveBeenCalledTimes(stage === 'blockhash' ? 0 : 1)
    expectNoSubmission(rpc)
  })
})

describe('planRequest cancellation between stages', () => {
  it('does not build an already cancelled plan', async () => {
    const rpc = setup()
    rpc.controller.abort('private reason')
    await expect(planRequest(rpc.ctx, binding)).rejects.toMatchObject(cancelled)
    expect(mocks.binding).not.toHaveBeenCalled()
    expect(rpc.getLatestBlockhash).not.toHaveBeenCalled()
    expect(rpc.simulateTransaction).not.toHaveBeenCalled()
    expectNoSubmission(rpc)
  })

  it('does not start simulation when instruction building finishes after cancellation', async () => {
    const rpc = setup()
    const pending = deferred<Instruction>()
    mocks.binding.mockReturnValue(pending.promise)
    const result = planRequest(rpc.ctx, binding)
    expect(mocks.binding).toHaveBeenCalledTimes(1)
    rpc.controller.abort('private reason')
    pending.resolve(instruction)
    await expect(result).rejects.toMatchObject(cancelled)
    expect(rpc.getLatestBlockhash).not.toHaveBeenCalled()
    expect(rpc.simulateTransaction).not.toHaveBeenCalled()
    expectNoSubmission(rpc)
  })

  it('does not fetch the unsigned transaction blockhash when simulation completes as cancellation arrives', async () => {
    const rpc = setup()
    rpc.simulationSend.mockResolvedValue({ value: {
      ...simulationResponse.value,
      get logs() {
        // Abort during result processing, after the cancellable RPC has settled.
        rpc.controller.abort('private reason')
        return simulationResponse.value.logs
      },
    } })
    await expect(planRequest(rpc.ctx, binding)).rejects.toMatchObject(cancelled)
    expect(rpc.simulationSend).toHaveBeenCalledTimes(1)
    expect(rpc.getLatestBlockhash).toHaveBeenCalledTimes(1)
    expectNoSubmission(rpc)
  })
})

describe('transfer SDK read adapter', () => {
  it.each(['base64', 'jsonParsed'] as const)('preserves %s arguments, response identity and reactiveStore', async (encoding) => {
    const rpc = setup()
    const config = { encoding, commitment: 'finalized' as const, minContextSlot: 42n }
    const response = { context: { slot: 42n }, value: {
      data: encoding === 'base64' ? ['AQID', 'base64'] : { parsed: { info: { amount: '7' } }, program: 'spl-token', space: 165 },
      owner: programId, lamports: 9n, executable: false,
    } }
    rpc.accountSend.mockResolvedValue(response)
    const extra = [{ address: programId!, role: AccountRole.READONLY }]
    mocks.resolve.mockImplementation(async ({ rpc: adapted }) => {
      const pending = adapted.getAccountInfo(mint, config)
      expect(pending.reactiveStore).toBe(rpc.reactiveStore)
      expect(await pending.send({ abortSignal: new AbortController().signal })).toBe(response)
      return extra
    })
    const instructions = await buildInstructions(rpc.ctx, transfer, createNoopSigner(wallet!))
    expect(mocks.readAccounts).toHaveBeenCalledWith(rpc.ctx, [sourceToken, destinationToken])
    expect(rpc.getAccountInfo).toHaveBeenCalledWith(mint, config)
    expect(rpc.getAccountInfo.mock.calls[0]![1]).toBe(config)
    expect(rpc.accountSend).toHaveBeenCalledWith({ abortSignal: rpc.controller.signal })
    expect(instructions[0]!.accounts!.slice(-extra.length)).toEqual(extra)
    expectNoSubmission(rpc)
  })

  it('passes the original RPC to the SDK when no read signal is provided', async () => {
    const rpc = setup(false)
    await buildInstructions(rpc.ctx, transfer, createNoopSigner(wallet!))
    expect(mocks.resolve.mock.calls[0]![0].rpc).toBe(rpc.ctx.rpc)
    expectNoSubmission(rpc)
  })

  it('cancels a hanging SDK read without converting cancellation into MissingExtraAccounts', async () => {
    const rpc = setup()
    const pending = deferred<never>()
    const started = deferred<void>()
    rpc.accountSend.mockImplementation(() => { started.resolve(); return pending.promise })
    mocks.resolve.mockImplementation(async ({ rpc: adapted }) => {
      await adapted.getAccountInfo(mint, { encoding: 'base64' }).send()
      return []
    })
    const result = planRequest(rpc.ctx, transfer)
    await started.promise
    rpc.controller.abort('private reason')
    await expect(result).rejects.toMatchObject(cancelled)
    pending.reject(new Error('late SDK transport error'))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(rpc.accountSend).toHaveBeenCalledWith({ abortSignal: rpc.controller.signal })
    expect(rpc.getLatestBlockhash).not.toHaveBeenCalled()
    expect(rpc.simulateTransaction).not.toHaveBeenCalled()
    expectNoSubmission(rpc)
  })

  it('prioritizes cancellation when the SDK throws a resolver error at the same time', async () => {
    const rpc = setup()
    mocks.resolve.mockImplementation(() => {
      rpc.controller.abort('private reason')
      throw new Error('private resolver failure')
    })
    await expect(planRequest(rpc.ctx, transfer)).rejects.toMatchObject(cancelled)
    expect(rpc.getLatestBlockhash).not.toHaveBeenCalled()
    expectNoSubmission(rpc)
  })
})
