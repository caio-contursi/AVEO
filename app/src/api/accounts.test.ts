import { getAddressDecoder } from '@solana/kit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readAccounts, type RpcReader } from './accounts'

const address = getAddressDecoder().decode(new Uint8Array(32).fill(1))
const owner = getAddressDecoder().decode(new Uint8Array(32).fill(2))

function reader(send: ReturnType<typeof vi.fn>, commitment: RpcReader['commitment'] = 'confirmed') {
  const getMultipleAccounts = vi.fn(() => ({ send }))
  const ctx = { rpc: { getMultipleAccounts }, commitment } as unknown as RpcReader
  return { ctx, getMultipleAccounts }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('readAccounts', () => {
  it('preserves order, null accounts, commitment, and minimum slot', async () => {
    const send = vi.fn().mockResolvedValue({
      context: { slot: 42n },
      value: [null, { owner, lamports: 9n, executable: false, data: ['AQID', 'base64'] }],
    })
    const { ctx, getMultipleAccounts } = reader(send, 'finalized')
    expect(await readAccounts(ctx, [owner, address], 42)).toEqual({
      slot: 42,
      accounts: [null, { address, owner, lamports: 9n, executable: false, data: new Uint8Array([1, 2, 3]) }],
    })
    expect(getMultipleAccounts).toHaveBeenCalledWith([owner, address], {
      encoding: 'base64', commitment: 'finalized', minContextSlot: 42n,
    })
    expect(send).toHaveBeenCalledWith({ abortSignal: expect.any(AbortSignal) })
  })

  it.each([0, 42, BigInt(Number.MAX_SAFE_INTEGER)])('accepts a safe slot %s and null account', async (slot) => {
    const { ctx } = reader(vi.fn().mockResolvedValue({ context: { slot }, value: [null] }))
    expect(await readAccounts(ctx, [address])).toEqual({ slot: Number(slot), accounts: [null] })
  })

  it.each([
    undefined, null, '42', true, {}, -1, -1n, 1.5, NaN, Infinity,
    Number.MAX_SAFE_INTEGER + 1, BigInt(Number.MAX_SAFE_INTEGER) + 1n,
  ])('rejects a malformed or unsafe slot %s', async (slot) => {
    const { ctx } = reader(vi.fn().mockResolvedValue({ context: { slot }, value: [null] }))
    await expect(readAccounts(ctx, [address])).rejects.toMatchObject({ code: 'ReadUnverifiable' })
  })

  it.each([null, {}, { context: null }, { context: {} }])('rejects missing response context %s', async (response) => {
    const { ctx } = reader(vi.fn().mockResolvedValue(response))
    await expect(readAccounts(ctx, [address])).rejects.toMatchObject({ code: 'ReadUnverifiable' })
  })

  it('rejects a slot below the requested minimum', async () => {
    const { ctx } = reader(vi.fn().mockResolvedValue({ context: { slot: 41n }, value: [null] }))
    await expect(readAccounts(ctx, [address], 42)).rejects.toMatchObject({
      code: 'ReadUnverifiable', message: 'Account read returned an invalid or stale slot.',
    })
  })

  it.each([[], [null, null], null, {}, [undefined], new Array(1)])('rejects missing or extra accounts %s', async (value) => {
    const { ctx } = reader(vi.fn().mockResolvedValue({ context: { slot: 42n }, value }))
    await expect(readAccounts(ctx, [address])).rejects.toMatchObject({ code: 'ReadUnverifiable' })
  })

  it.each([undefined, 0])('returns an empty observation sentinel with minimum %s without RPC', async (minimum) => {
    const { ctx, getMultipleAccounts } = reader(vi.fn())
    expect(await readAccounts(ctx, [], minimum)).toEqual({ slot: 0, accounts: [] })
    expect(getMultipleAccounts).not.toHaveBeenCalled()
  })

  it('rejects an empty read with a positive minimum without RPC', async () => {
    const { ctx, getMultipleAccounts } = reader(vi.fn())
    await expect(readAccounts(ctx, [], 42)).rejects.toMatchObject({
      code: 'ReadUnverifiable', message: 'Empty account read cannot satisfy a minimum slot.',
    })
    expect(getMultipleAccounts).not.toHaveBeenCalled()
  })

  it('preserves the static account cardinality reason', async () => {
    const { ctx } = reader(vi.fn().mockResolvedValue({ context: { slot: 42n }, value: [] }))
    await expect(readAccounts(ctx, [address])).rejects.toMatchObject({
      code: 'ReadUnverifiable', message: 'Account read returned an invalid account count.',
    })
  })

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid minimum slot %s before RPC', async (slot) => {
    const { ctx, getMultipleAccounts } = reader(vi.fn())
    await expect(readAccounts(ctx, [address], slot)).rejects.toMatchObject({ code: 'ReadUnverifiable' })
    expect(getMultipleAccounts).not.toHaveBeenCalled()
  })

  it.each([0, -1, 1.5, NaN, Infinity, 2_147_483_648])('rejects invalid timeout %s before RPC', async (timeout) => {
    const { ctx, getMultipleAccounts } = reader(vi.fn())
    await expect(readAccounts(ctx, [address], undefined, timeout)).rejects.toMatchObject({ code: 'ReadUnverifiable' })
    expect(getMultipleAccounts).not.toHaveBeenCalled()
  })

  it('bounds a hanging RPC with the default deadline and aborts its signal', async () => {
    vi.useFakeTimers()
    const send = vi.fn((_options: { abortSignal: AbortSignal }) => new Promise<never>(() => {}))
    const { ctx } = reader(send)
    const result = readAccounts(ctx, [address])
    const assertion = expect(result).rejects.toMatchObject({ code: 'ReadUnverifiable', message: 'Account read timed out.' })
    const signal = send.mock.calls[0]![0].abortSignal as AbortSignal
    await vi.advanceTimersByTimeAsync(9_999)
    expect(signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await assertion
    expect(signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('handles a late rejection from a transport that ignores abort', async () => {
    vi.useFakeTimers()
    let rejectRpc!: (error: Error) => void
    const send = vi.fn(() => new Promise<never>((_, reject) => { rejectRpc = reject }))
    const { ctx } = reader(send)
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const assertion = expect(readAccounts(ctx, [address], undefined, 25)).rejects.toMatchObject({ code: 'ReadUnverifiable' })
      await vi.advanceTimersByTimeAsync(25)
      await assertion
      rejectRpc(new Error('https://rpc.invalid/?api-key=secret'))
      await vi.advanceTimersByTimeAsync(0)
      expect(unhandled).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('keeps timeout errors static when the transport rejects during abort', async () => {
    vi.useFakeTimers()
    const send = vi.fn(({ abortSignal }: { abortSignal: AbortSignal }) => new Promise<never>((_, reject) => {
      abortSignal.addEventListener('abort', () => reject(new Error('secret RPC endpoint')), { once: true })
    }))
    const { ctx } = reader(send)
    const assertion = expect(readAccounts(ctx, [address], undefined, 25)).rejects.toMatchObject({
      code: 'ReadUnverifiable', message: 'Account read timed out.',
    })
    await vi.advanceTimersByTimeAsync(25)
    await assertion
  })

  it('redacts raw transport errors', async () => {
    const { ctx } = reader(vi.fn().mockRejectedValue(new Error('secret endpoint')))
    await expect(readAccounts(ctx, [address])).rejects.toMatchObject({
      code: 'ReadUnverifiable', message: 'Account read failed.',
    })
  })

  it('clears the deadline after success and omits an unspecified minimum slot', async () => {
    vi.useFakeTimers()
    const { ctx, getMultipleAccounts } = reader(vi.fn().mockResolvedValue({ context: { slot: 42n }, value: [null] }))
    await readAccounts(ctx, [address])
    expect(getMultipleAccounts).toHaveBeenCalledWith([address], { encoding: 'base64', commitment: 'confirmed' })
    expect(vi.getTimerCount()).toBe(0)
  })
})
