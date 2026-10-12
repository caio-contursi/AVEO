import { getAddressDecoder, getBase58Decoder, type Commitment, type Signature, type TransactionSigner } from '@solana/kit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AVEO_HOOK_PROGRAM_ID } from './constants'
import type { ApiContext } from './context'
import { confirmSignature, signAndSend, SubmissionUnknownError, type PlanRequest } from './transactions'

const signing = vi.hoisted(() => ({ sign: vi.fn(), send: vi.fn(), binding: vi.fn() }))
vi.mock('@solana/kit', async (original) => ({
  ...await original<typeof import('@solana/kit')>(),
  signTransactionMessageWithSigners: signing.sign,
  signAndSendTransactionMessageWithSigners: signing.send,
}))
vi.mock('./instructions', async (original) => ({
  ...await original<typeof import('./instructions')>(), getSetBindingInstruction: signing.binding,
}))

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

describe('signAndSend submission boundaries', () => {
  const wallet = getAddressDecoder().decode(new Uint8Array(32).fill(2))
  const request: PlanRequest = {
    kind: 'set-binding', mints: [wallet], wallet, credential: wallet, schema: wallet, attestation: wallet,
  }
  const signatureBytes = new Uint8Array(64).fill(3)
  const exactSignature = getBase58Decoder().decode(signatureBytes) as Signature
  const localSigner = { address: wallet, signTransactions: vi.fn() } as TransactionSigner
  const sendingSigner = { address: wallet, signAndSendTransactions: vi.fn() } as TransactionSigner

  function setup() {
    const blockhashSend = vi.fn().mockResolvedValue({
      value: { blockhash: getAddressDecoder().decode(new Uint8Array(32).fill(4)), lastValidBlockHeight: 99n },
    })
    const send = vi.fn().mockResolvedValue(exactSignature)
    const sendTransaction = vi.fn(() => ({ send }))
    const ctx = {
      commitment: 'confirmed', programId: AVEO_HOOK_PROGRAM_ID,
      rpc: { getLatestBlockhash: vi.fn(() => ({ send: blockhashSend })), sendTransaction },
    } as unknown as ApiContext
    return { ctx, blockhashSend, send, sendTransaction }
  }

  beforeEach(() => {
    vi.resetAllMocks()
    signing.binding.mockResolvedValue({ programAddress: AVEO_HOOK_PROGRAM_ID, accounts: [], data: new Uint8Array() })
    signing.sign.mockResolvedValue({ messageBytes: new Uint8Array([1]), signatures: { [wallet]: signatureBytes } })
    signing.send.mockResolvedValue(signatureBytes)
  })

  it('records the exact signed signature before transmitting, retaining it when the RPC response is lost', async () => {
    const rpc = setup()
    const onSent = vi.fn()
    rpc.send.mockImplementationOnce(async () => {
      expect(onSent).toHaveBeenCalledExactlyOnceWith(exactSignature)
      throw new Error('Transmitted, response lost')
    })
    await expect(signAndSend(rpc.ctx, request, localSigner, undefined, onSent)).rejects.toMatchObject({
      name: 'SubmissionUnknownError', signature: exactSignature,
    })
    expect(rpc.sendTransaction).toHaveBeenCalledTimes(1)
    expect(rpc.send).toHaveBeenCalledTimes(1)
    expect(onSent).toHaveBeenCalledTimes(1)
  })

  it.each(['Wallet rejected', 'Transport failed'])('treats sending-wallet failure as ambiguous regardless of its message: %s', async (message) => {
    const rpc = setup()
    const onSent = vi.fn()
    signing.send.mockRejectedValueOnce(new Error(message))
    const error = await signAndSend(rpc.ctx, request, sendingSigner, undefined, onSent).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(SubmissionUnknownError)
    expect(error).toMatchObject({ signature: undefined })
    expect(onSent).not.toHaveBeenCalled()
    expect(rpc.sendTransaction).not.toHaveBeenCalled()
  })

  it.each(['instructions', 'blockhash', 'signing'] as const)('keeps %s failures before broadcast as normal errors', async (stage) => {
    const rpc = setup()
    const failure = new Error('No broadcast occurred')
    if (stage === 'instructions') signing.binding.mockRejectedValueOnce(failure)
    if (stage === 'blockhash') rpc.blockhashSend.mockRejectedValueOnce(failure)
    if (stage === 'signing') signing.sign.mockRejectedValueOnce(failure)
    const onSent = vi.fn()
    const error = await signAndSend(rpc.ctx, request, localSigner, undefined, onSent).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(SubmissionUnknownError)
    expect(onSent).not.toHaveBeenCalled()
    expect(rpc.sendTransaction).not.toHaveBeenCalled()
    expect(signing.send).not.toHaveBeenCalled()
  })

  it('keeps a sending-wallet prebuild failure outside the ambiguous boundary', async () => {
    const rpc = setup()
    const failure = new Error('Instruction build failed')
    signing.binding.mockRejectedValueOnce(failure)
    await expect(signAndSend(rpc.ctx, request, sendingSigner)).rejects.toBe(failure)
    expect(signing.send).not.toHaveBeenCalled()
  })

  it.each(['local', 'sending'] as const)('blocks %s wallet invocation when the durable reservation fails', async (kind) => {
    const rpc = setup()
    const failure = new Error('Durable reservation unavailable')
    const beforeWallet = vi.fn().mockRejectedValue(failure)
    await expect(signAndSend(rpc.ctx, request, kind === 'local' ? localSigner : sendingSigner, undefined, undefined, beforeWallet)).rejects.toBe(failure)
    expect(beforeWallet).toHaveBeenCalledTimes(1)
    expect(signing.sign).not.toHaveBeenCalled()
    expect(signing.send).not.toHaveBeenCalled()
    expect(rpc.sendTransaction).not.toHaveBeenCalled()
  })

  it.each(['local', 'sending'] as const)('waits for durable reservation before invoking the %s wallet', async (kind) => {
    const rpc = setup()
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const beforeWallet = vi.fn(() => pending)
    const outcome = signAndSend(rpc.ctx, request, kind === 'local' ? localSigner : sendingSigner, undefined, undefined, beforeWallet)
    await vi.waitFor(() => expect(beforeWallet).toHaveBeenCalledTimes(1))
    expect(signing.sign).not.toHaveBeenCalled()
    expect(signing.send).not.toHaveBeenCalled()
    release()
    expect(await outcome).toBe(exactSignature)
    expect(kind === 'local' ? signing.sign : signing.send).toHaveBeenCalledTimes(1)
  })

  it('does not cross the wallet boundary when instruction preparation fails', async () => {
    const rpc = setup()
    signing.binding.mockRejectedValueOnce(new Error('Invalid instructions'))
    const beforeWallet = vi.fn()
    await expect(signAndSend(rpc.ctx, request, sendingSigner, undefined, undefined, beforeWallet)).rejects.toThrow('Invalid instructions')
    expect(beforeWallet).not.toHaveBeenCalled()
    expect(signing.send).not.toHaveBeenCalled()
  })

  it('awaits durable signature recording before local RPC broadcast', async () => {
    const rpc = setup()
    let release!: () => void
    const persist = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const outcome = signAndSend(rpc.ctx, request, localSigner, undefined, undefined, undefined, persist)
    await vi.waitFor(() => expect(persist).toHaveBeenCalledExactlyOnceWith(exactSignature))
    expect(rpc.sendTransaction).not.toHaveBeenCalled()
    release()
    expect(await outcome).toBe(exactSignature)
    expect(rpc.send).toHaveBeenCalledTimes(1)
  })

  it.each(['local', 'sending'] as const)('retains the signature on %s persistence failure without a Desk broadcast', async (kind) => {
    const rpc = setup()
    const persist = vi.fn().mockRejectedValue(new Error('Storage unavailable'))
    await expect(signAndSend(rpc.ctx, request, kind === 'local' ? localSigner : sendingSigner, undefined, undefined, undefined, persist)).rejects.toMatchObject({
      name: 'SubmissionUnknownError', signature: exactSignature,
    })
    expect(persist).toHaveBeenCalledExactlyOnceWith(exactSignature)
    expect(rpc.sendTransaction).not.toHaveBeenCalled()
  })

  it.each(['local', 'sending'] as const)('ignores a throwing receipt callback without preventing %s submission or fabricating an error', async (kind) => {
    const rpc = setup()
    const onSent = vi.fn(() => { throw new Error('Receipt unavailable') })
    expect(await signAndSend(rpc.ctx, request, kind === 'local' ? localSigner : sendingSigner, undefined, onSent)).toBe(exactSignature)
    expect(onSent).toHaveBeenCalledExactlyOnceWith(exactSignature)
    expect(rpc.send).toHaveBeenCalledTimes(kind === 'local' ? 1 : 0)
    expect(signing.send).toHaveBeenCalledTimes(kind === 'sending' ? 1 : 0)
  })

  it('does not let a throwing callback replace an ambiguous RPC failure', async () => {
    const rpc = setup()
    rpc.send.mockRejectedValueOnce(new Error('Lost RPC response'))
    const onSent = vi.fn(() => { throw new Error('Private receipt error') })
    await expect(signAndSend(rpc.ctx, request, localSigner, undefined, onSent)).rejects.toMatchObject({
      name: 'SubmissionUnknownError', signature: exactSignature, message: 'Transaction submission is unknown; do not resend.',
    })
    expect(rpc.send).toHaveBeenCalledTimes(1)
  })
})

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
