import { getAddressDecoder } from '@solana/kit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readAccount, readAccounts, type RpcReader } from './accounts'

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
  it.each([false, true])('rejects pre-aborted requests without RPC, empty: %s', async (empty) => {
    vi.useFakeTimers()
    const controller = new AbortController()
    controller.abort(new Error('secret reason'))
    const send = vi.fn()
    const { ctx, getMultipleAccounts } = reader(send)
    ctx.readAbortSignal = controller.signal
    await expect(readAccounts(ctx, empty ? [] : [address])).rejects.toMatchObject({ name: 'AbortError', message: 'Read cancelled.' })
    expect(getMultipleAccounts).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([false, true])('cancels promptly when transport rejects on abort: %s', async (rejectOnAbort) => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const send = vi.fn(({ abortSignal }: { abortSignal: AbortSignal }) => new Promise<never>((_, reject) => {
      if (rejectOnAbort) abortSignal.addEventListener('abort', () => reject(new Error('secret transport')), { once: true })
    }))
    const { ctx } = reader(send)
    ctx.readAbortSignal = controller.signal
    const result = readAccount(ctx, address)
    const transportSignal = send.mock.calls[0]![0].abortSignal
    expect(transportSignal).not.toBe(controller.signal)
    controller.abort(new Error('secret abort reason'))
    await expect(result).rejects.toMatchObject({ name: 'AbortError', message: 'Read cancelled.' })
    expect(transportSignal.aborted).toBe(true)
    expect(transportSignal.reason).not.toEqual(new Error('secret abort reason'))
    expect(vi.getTimerCount()).toBe(0)
    expect(remove).toHaveBeenCalledTimes(add.mock.calls.length)
    for (const [, listener] of add.mock.calls) expect(remove).toHaveBeenCalledWith('abort', listener)
  })

  it('handles a late transport rejection after external cancellation', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    let rejectRpc!: (error: Error) => void
    const { ctx } = reader(vi.fn(() => new Promise<never>((_, reject) => { rejectRpc = reject })))
    ctx.readAbortSignal = controller.signal
    const result = readAccounts(ctx, [address])
    controller.abort('secret reason')
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    rejectRpc(new Error('secret endpoint'))
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not abort a completed transport when its former caller later cancels', async () => {
    const controller = new AbortController()
    const send = vi.fn((_options: { abortSignal: AbortSignal }) => Promise.resolve({
      context: { slot: 42n }, value: [null],
    }))
    const { ctx } = reader(send)
    ctx.readAbortSignal = controller.signal
    await readAccount(ctx, address)
    controller.abort('secret reason')
    expect(send.mock.calls[0]![0].abortSignal.aborted).toBe(false)
  })

  it.each(['success', 'failure', 'timeout', 'validation failure'] as const)(
    'removes external listeners and timers after %s', async (outcome) => {
      vi.useFakeTimers()
      const controller = new AbortController()
      const add = vi.spyOn(controller.signal, 'addEventListener')
      const remove = vi.spyOn(controller.signal, 'removeEventListener')
      const send = vi.fn(() => {
        if (outcome === 'failure') throw new Error('secret endpoint')
        if (outcome === 'timeout') return new Promise<never>(() => {})
        return Promise.resolve({ context: { slot: outcome === 'validation failure' ? -1n : 42n }, value: [null] })
      })
      const { ctx } = reader(send)
      ctx.readAbortSignal = controller.signal
      const result = readAccounts(ctx, [address], undefined, 25)
      if (outcome === 'success') await expect(result).resolves.toMatchObject({ slot: 42 })
      else {
        const assertion = expect(result).rejects.toMatchObject({
          code: 'ReadUnverifiable',
          ...(outcome === 'timeout' ? { message: 'Account read timed out.' } : {}),
        })
        if (outcome === 'timeout') await vi.advanceTimersByTimeAsync(25)
        await assertion
      }
      expect(controller.signal.aborted).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
      expect(remove).toHaveBeenCalledTimes(add.mock.calls.length)
      for (const [, listener] of add.mock.calls) expect(remove).toHaveBeenCalledWith('abort', listener)
    },
  )

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
