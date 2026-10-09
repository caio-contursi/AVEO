import type { Commitment, Signature } from '@solana/kit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AVEO_HOOK_PROGRAM_ID } from './constants'
import type { ApiContext } from './context'
import { confirmSignature } from './transactions'

const signature = 'test-signature' as Signature
const transactionError = { InstructionError: [0, { Custom: 6000 }] }
const logs = [`Program ${AVEO_HOOK_PROGRAM_ID} failed: custom program error: 0x1770`]
const status = (confirmationStatus: Commitment, err: unknown = null) => ({
  slot: 42n,
  confirmationStatus,
  err,
})

function fakeRpc(commitment: Commitment = 'confirmed') {
  const statusSend = vi.fn().mockResolvedValue({ value: [null] })
  const transactionSend = vi.fn().mockResolvedValue(null)
  const getSignatureStatuses = vi.fn(() => ({ send: statusSend }))
  const getTransaction = vi.fn(() => ({ send: transactionSend }))
  const sendTransaction = vi.fn(() => { throw new Error('Confirmation must never send a transaction') })
  const ctx = {
    commitment,
    programId: AVEO_HOOK_PROGRAM_ID,
    rpc: { getSignatureStatuses, getTransaction, sendTransaction },
  } as unknown as ApiContext
  return { ctx, statusSend, transactionSend, getSignatureStatuses, getTransaction, sendTransaction }
}

describe('confirmSignature', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    try {
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['null', 'rejected', 'hanging'] as const)('returns unknown at the deadline for %s status RPCs without resubmitting', async (response) => {
    const rpc = fakeRpc()
    if (response === 'rejected') rpc.statusSend.mockRejectedValue(new Error('RPC unavailable'))
    if (response === 'hanging') rpc.statusSend.mockImplementation(() => new Promise(() => {}))
    const result = confirmSignature(rpc.ctx, signature, 2500)
    await vi.advanceTimersByTimeAsync(2500)
    expect(await result).toMatchObject({ status: 'unknown', logs: [], error: { code: 'ConfirmationUnknown' } })
    expect(rpc.sendTransaction).not.toHaveBeenCalled()
    expect(rpc.getTransaction).not.toHaveBeenCalled()
    expect(rpc.getSignatureStatuses).toHaveBeenCalledWith([signature], { searchTransactionHistory: true })
  })

  it('recovers from an RPC error and absent status to eventual confirmation', async () => {
    const rpc = fakeRpc()
    rpc.statusSend.mockRejectedValueOnce(new Error('RPC timeout'))
      .mockResolvedValueOnce({ value: [null] })
      .mockResolvedValue({ value: [status('confirmed')] })
    rpc.transactionSend.mockResolvedValue({ meta: { logMessages: ['Program completed'] } })
    const result = confirmSignature(rpc.ctx, signature, 5000)
    await vi.advanceTimersByTimeAsync(2400)
    expect(await result).toEqual({ status: 'confirmed', slot: 42, logs: ['Program completed'] })
    expect(rpc.statusSend).toHaveBeenCalledTimes(3)
    expect(rpc.sendTransaction).not.toHaveBeenCalled()
  })

  it('returns a confirmed transaction failure with its hook diagnostic and logs', async () => {
    const rpc = fakeRpc()
    rpc.statusSend.mockResolvedValue({ value: [status('confirmed', transactionError)] })
    rpc.transactionSend.mockResolvedValue({ meta: { logMessages: logs } })
    const result = await confirmSignature(rpc.ctx, signature)
    expect(result).toMatchObject({ status: 'failed', slot: 42, logs, error: { code: 'NotTransferContext' } })
  })

  it.each([null, transactionError])('does not accept merely confirmed status at finalized commitment (error: %j)', async (err) => {
    const rpc = fakeRpc('finalized')
    rpc.statusSend.mockResolvedValue({ value: [status('confirmed', err)] })
    const result = confirmSignature(rpc.ctx, signature, 2500)
    await vi.advanceTimersByTimeAsync(2500)
    expect(await result).toMatchObject({ status: 'unknown', error: { code: 'ConfirmationUnknown' } })
    expect(rpc.getTransaction).not.toHaveBeenCalled()
  })

  it.each([null, transactionError])('waits for finalized status and requests finalized logs (error: %j)', async (err) => {
    const rpc = fakeRpc('finalized')
    rpc.statusSend.mockResolvedValueOnce({ value: [status('confirmed', err)] })
      .mockResolvedValue({ value: [status('finalized', err)] })
    rpc.transactionSend.mockResolvedValue({ meta: { logMessages: err ? logs : [] } })
    const result = confirmSignature(rpc.ctx, signature, 2500)
    await vi.advanceTimersByTimeAsync(1200)
    expect(await result).toMatchObject({ status: err ? 'failed' : 'confirmed', slot: 42 })
    expect(rpc.getTransaction).toHaveBeenCalledWith(signature, {
      encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'finalized',
    })
  })

  it.each(['processed', 'confirmed'] as const)('keeps a processed failure unknown while confirmed logs are unavailable (%s commitment)', async (commitment) => {
    const rpc = fakeRpc(commitment)
    rpc.statusSend.mockResolvedValue({ value: [status('processed', transactionError)] })
    const result = confirmSignature(rpc.ctx, signature, 2500)
    await vi.advanceTimersByTimeAsync(2500)
    expect(await result).toMatchObject({ status: 'unknown', logs: [], error: { code: 'ConfirmationUnknown' } })
    expect(rpc.getTransaction).not.toHaveBeenCalled()
    expect(rpc.sendTransaction).not.toHaveBeenCalled()
  })

  it('waits for a processed failure to become confirmed before translating its logs', async () => {
    const rpc = fakeRpc()
    rpc.statusSend.mockResolvedValueOnce({ value: [status('processed', transactionError)] })
      .mockResolvedValue({ value: [status('confirmed', transactionError)] })
    rpc.transactionSend.mockResolvedValue({ meta: { logMessages: logs } })
    const result = confirmSignature(rpc.ctx, signature, 2500)
    await vi.advanceTimersByTimeAsync(0)
    expect(rpc.getTransaction).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1200)
    expect(await result).toMatchObject({ status: 'failed', slot: 42, logs })
  })

  it('accepts successful processed status only when processed commitment is selected', async () => {
    const rpc = fakeRpc('processed')
    rpc.statusSend.mockResolvedValue({ value: [status('processed')] })
    expect(await confirmSignature(rpc.ctx, signature)).toEqual({ status: 'confirmed', slot: 42, logs: [] })
    expect(rpc.getTransaction).toHaveBeenCalledWith(signature, {
      encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed',
    })
  })

  it('bounds a hanging log RPC by the remaining deadline', async () => {
    const rpc = fakeRpc()
    rpc.statusSend.mockResolvedValueOnce({ value: [null] })
      .mockResolvedValue({ value: [status('confirmed')] })
    rpc.transactionSend.mockImplementation(() => new Promise(() => {}))
    const result = confirmSignature(rpc.ctx, signature, 2500)
    await vi.advanceTimersByTimeAsync(2500)
    expect(await result).toMatchObject({ status: 'unknown', error: { code: 'ConfirmationUnknown' } })
    expect(rpc.getTransaction).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['status', 'hanging'], ['status', 'abort rejection'], ['status', 'late rejection'],
    ['logs', 'hanging'], ['logs', 'abort rejection'], ['logs', 'late rejection'],
  ] as const)('aborts the %s RPC at the deadline with %s and clears timers', async (stage, response) => {
    const rpc = fakeRpc()
    let signal: AbortSignal | undefined
    let rejectRequest!: (error: unknown) => void
    const hangingRequest = ({ abortSignal }: { abortSignal: AbortSignal }) => {
      signal = abortSignal
      return new Promise((_resolve, reject) => {
        rejectRequest = reject
        if (response === 'abort rejection') {
          abortSignal.addEventListener('abort', () => reject(abortSignal.reason), { once: true })
        }
      })
    }
    if (stage === 'status') rpc.statusSend.mockImplementation(hangingRequest)
    else {
      rpc.statusSend.mockResolvedValueOnce({ value: [null] })
        .mockResolvedValue({ value: [status('confirmed', transactionError)] })
      rpc.transactionSend.mockImplementation(hangingRequest)
    }
    const result = confirmSignature(rpc.ctx, signature, 2500)
    await vi.advanceTimersByTimeAsync(2499)
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal?.aborted).toBe(false)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(signal?.aborted).toBe(true)
    expect(await result).toMatchObject({ status: 'unknown', logs: [], error: { code: 'ConfirmationUnknown' } })
    expect(vi.getTimerCount()).toBe(0)
    if (response === 'late rejection') rejectRequest(new Error('Late transport failure'))
    await vi.advanceTimersByTimeAsync(5000)
    expect(await result).toMatchObject({ status: 'unknown' })
    expect(vi.getTimerCount()).toBe(0)
    expect(rpc.statusSend).toHaveBeenCalledTimes(stage === 'status' ? 1 : 2)
    expect(rpc.transactionSend).toHaveBeenCalledTimes(stage === 'status' ? 0 : 1)
    expect(rpc.sendTransaction).not.toHaveBeenCalled()
  })

  it.each(['resolved', 'rejected'] as const)('ignores a status RPC that is %s after the deadline', async (response) => {
    const rpc = fakeRpc()
    let resolveStatus!: (value: unknown) => void
    let rejectStatus!: (error: Error) => void
    rpc.statusSend.mockImplementation(() => new Promise((resolve, reject) => {
      resolveStatus = resolve
      rejectStatus = reject
    }))
    const result = confirmSignature(rpc.ctx, signature, 2500)
    await vi.advanceTimersByTimeAsync(2500)
    const confirmation = await result
    expect(confirmation.status).toBe('unknown')
    if (response === 'resolved') resolveStatus({ value: [status('confirmed')] })
    else rejectStatus(new Error('Late RPC rejection'))
    await vi.advanceTimersByTimeAsync(5000)
    expect(await result).toBe(confirmation)
    expect(rpc.getTransaction).not.toHaveBeenCalled()
    expect(rpc.statusSend).toHaveBeenCalledTimes(1)
    expect(rpc.sendTransaction).not.toHaveBeenCalled()
  })

  it('does not preserve a processed error that disappears before confirmation', async () => {
    const rpc = fakeRpc()
    rpc.statusSend.mockResolvedValueOnce({ value: [status('processed', transactionError)] })
      .mockResolvedValueOnce({ value: [null] })
      .mockResolvedValue({ value: [status('confirmed')] })
    const result = confirmSignature(rpc.ctx, signature, 5000)
    await vi.advanceTimersByTimeAsync(2400)
    expect(await result).toEqual({ status: 'confirmed', slot: 42, logs: [] })
  })

  it('returns unknown without requesting RPCs when the deadline has already expired', async () => {
    const rpc = fakeRpc()
    expect(await confirmSignature(rpc.ctx, signature, 0)).toMatchObject({
      status: 'unknown', error: { code: 'ConfirmationUnknown' },
    })
    expect(rpc.getSignatureStatuses).not.toHaveBeenCalled()
  })

  it.each(['null', 'rejected'] as const)('preserves stable failure evidence when log RPC is %s', async (response) => {
    const rpc = fakeRpc()
    rpc.statusSend.mockResolvedValue({ value: [status('confirmed', transactionError)] })
    if (response === 'rejected') rpc.transactionSend.mockRejectedValue(new Error('Logs unavailable'))
    expect(await confirmSignature(rpc.ctx, signature)).toMatchObject({
      status: 'failed', slot: 42, logs: [], error: { code: 'SimulationFailed' },
    })
  })
})
