import { appendTransactionMessageInstruction, blockhash as parseBlockhash, compileTransaction, createTransactionMessage, getAddressDecoder, getBase58Decoder, getBase64EncodedWireTransaction, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, type SignatureBytes } from '@solana/kit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiContext } from './context'
import { messageFingerprint, verifySubmissionMessage } from './submission-proof'

function fixture() {
  const wallet = getAddressDecoder().decode(new Uint8Array(32).fill(2))
  const blockhash = getAddressDecoder().decode(new Uint8Array(32).fill(3))
  const message = appendTransactionMessageInstruction({ programAddress: blockhash, data: new Uint8Array([1]) },
    setTransactionMessageLifetimeUsingBlockhash({ blockhash: parseBlockhash(blockhash), lastValidBlockHeight: 99n },
      setTransactionMessageFeePayer(wallet, createTransactionMessage({ version: 0 }))))
  const unsigned = compileTransaction(message)
  const signatureBytes = new Uint8Array(64).fill(4) as SignatureBytes
  const signature = getBase58Decoder().decode(signatureBytes)
  const transaction = { ...unsigned, signatures: { [wallet]: signatureBytes } }
  const result = { slot: 42n, meta: { err: null }, transaction: [getBase64EncodedWireTransaction(transaction), 'base64'] }
  const send = vi.fn().mockResolvedValue(result)
  const getTransaction = vi.fn(() => ({ send }))
  const ctx = { commitment: 'confirmed', rpc: { getTransaction } } as unknown as ApiContext
  return { ctx, getTransaction, send, signature, result, transaction }
}

afterEach(() => vi.useRealTimers())

describe('original transaction message evidence', () => {
  it.each(['confirmed', 'failed'] as const)('accepts only the exact submitted message and signature for %s', async (status) => {
    const f = fixture()
    f.send.mockResolvedValue({ ...f.result, meta: { err: status === 'confirmed' ? null : { InstructionError: [0, 'InvalidAccountData'] } } })
    const hash = await messageFingerprint(f.transaction.messageBytes)
    expect(await verifySubmissionMessage(f.ctx, f.signature, hash)).toEqual({ signature: f.signature, status, slot: 42, verifiedMessageFingerprint: hash })
    expect(f.getTransaction).toHaveBeenCalledWith(f.signature, { encoding: 'base64', maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
  })

  it('rejects a correctly formatted signature belonging to a different transaction', async () => {
    const f = fixture()
    const otherSignature = getBase58Decoder().decode(new Uint8Array(64).fill(5))
    expect(await verifySubmissionMessage(f.ctx, otherSignature, await messageFingerprint(f.transaction.messageBytes))).toBeUndefined()
  })

  it.each([1, 42, Number.MAX_SAFE_INTEGER, 1n, 42n, BigInt(Number.MAX_SAFE_INTEGER)].map((slot) => ({ slot })))(
    'accepts a positive safely representable number or bigint slot $slot', async ({ slot }) => {
      const f = fixture()
      f.send.mockResolvedValue({ ...f.result, slot })
      const hash = await messageFingerprint(f.transaction.messageBytes)
      expect(await verifySubmissionMessage(f.ctx, f.signature, hash)).toEqual({
        signature: f.signature, status: 'confirmed', slot: Number(slot), verifiedMessageFingerprint: hash,
      })
    },
  )

  it.each([null, undefined, false, true, '', '42', '0', 0, 0n, -1, -1n, 1.5, NaN, Infinity, -Infinity,
    Number.MAX_SAFE_INTEGER + 1, BigInt(Number.MAX_SAFE_INTEGER) + 1n, [], {}, { valueOf: () => 42 }].map((slot) => ({ slot })))(
    'rejects malformed slot $slot with matching transaction bytes before wire decoding', async ({ slot }) => {
      const f = fixture()
      const result = { ...f.result, slot }
      const wire = vi.fn(() => f.result.transaction)
      Object.defineProperty(result, 'transaction', { get: wire })
      f.send.mockResolvedValue(result)
      expect(await verifySubmissionMessage(f.ctx, f.signature, await messageFingerprint(f.transaction.messageBytes))).toBeUndefined()
      expect(wire).not.toHaveBeenCalled()
    },
  )

  it.each([
    { InstructionError: [0, 'InvalidAccountData'] },
    { InstructionError: [255, 'x'.repeat(128)] },
    { InstructionError: [0, { Custom: 0 }] },
    { InstructionError: [255, { Custom: 0xffff_ffff }] },
  ].map((err) => ({ err })))(
    'accepts only the documented structured instruction error subset $err', async ({ err }) => {
      const f = fixture()
      f.send.mockResolvedValue({ ...f.result, meta: { err } })
      const hash = await messageFingerprint(f.transaction.messageBytes)
      expect(await verifySubmissionMessage(f.ctx, f.signature, hash)).toEqual({
        signature: f.signature, status: 'failed', slot: 42, verifiedMessageFingerprint: hash,
      })
    },
  )

  it.each([
    undefined, false, true, 0, 1, '', 'AccountNotFound', [], {},
    { InstructionError: [] }, { InstructionError: [0] }, { InstructionError: [0, 'InvalidAccountData', 'extra'] },
    { InstructionError: [-1, 'InvalidAccountData'] }, { InstructionError: [256, 'InvalidAccountData'] },
    { InstructionError: [0.5, 'InvalidAccountData'] }, { InstructionError: ['0', 'InvalidAccountData'] },
    { InstructionError: [false, 'InvalidAccountData'] }, { InstructionError: [0n, 'InvalidAccountData'] },
    { InstructionError: [0, ''] }, { InstructionError: [0, 'x'.repeat(129)] },
    { InstructionError: [0, false] }, { InstructionError: [0, null] }, { InstructionError: [0, {}] },
    { InstructionError: [0, { Custom: -1 }] }, { InstructionError: [0, { Custom: 0x1_0000_0000 }] },
    { InstructionError: [0, { Custom: 0.5 }] }, { InstructionError: [0, { Custom: '1' }] },
    { InstructionError: [0, { Custom: false }] }, { InstructionError: [0, { Custom: 1n }] },
    { InstructionError: [0, { Custom: NaN }] }, { InstructionError: [0, { Custom: Infinity }] },
    { InstructionError: [0, { Custom: 1, extra: true }] },
    { InstructionError: [0, 'InvalidAccountData'], extra: true },
    Object.create({ InstructionError: [0, 'InvalidAccountData'] }),
    { InstructionError: [0, Object.create({ Custom: 1 })] },
  ].map((err) => ({ err })))(
    'rejects malformed or unsupported error $err with matching transaction bytes', async ({ err }) => {
      const f = fixture()
      f.send.mockResolvedValue({ ...f.result, meta: { err } })
      expect(await verifySubmissionMessage(f.ctx, f.signature, await messageFingerprint(f.transaction.messageBytes))).toBeUndefined()
    },
  )

  it('rejects inherited metadata err fields with matching transaction bytes', async () => {
    const f = fixture()
    f.send.mockResolvedValue({ ...f.result, meta: Object.create({ err: null }) })
    expect(await verifySubmissionMessage(f.ctx, f.signature, await messageFingerprint(f.transaction.messageBytes))).toBeUndefined()
  })

  it('rejects a different original message even when the signature is unchanged', async () => {
    const f = fixture()
    expect(await verifySubmissionMessage(f.ctx, f.signature, await messageFingerprint(new Uint8Array([99])))).toBeUndefined()
  })

  it.each([null, { slot: 42n, meta: null }, { slot: 42n, meta: {} }, { slot: -1n, meta: { err: null } }, { slot: 42n, meta: { err: null }, transaction: ['A'.repeat(4097), 'base64'] }, { slot: 42n, meta: { err: null }, transaction: ['invalid', 'json'] }])('retains the blocker for unavailable or malformed chain evidence', async (result) => {
    const f = fixture()
    f.send.mockResolvedValue(result)
    expect(await verifySubmissionMessage(f.ctx, f.signature, await messageFingerprint(f.transaction.messageBytes))).toBeUndefined()
  })

  it('does not query processed commitment or invalid signatures', async () => {
    const f = fixture()
    const hash = await messageFingerprint(f.transaction.messageBytes)
    expect(await verifySubmissionMessage({ ...f.ctx, commitment: 'processed' }, f.signature, hash)).toBeUndefined()
    expect(await verifySubmissionMessage(f.ctx, 'invalid', hash)).toBeUndefined()
    expect(f.send).not.toHaveBeenCalled()
  })

  it('uses finalized commitment when the original context requires it', async () => {
    const f = fixture()
    await verifySubmissionMessage({ ...f.ctx, commitment: 'finalized' }, f.signature, await messageFingerprint(f.transaction.messageBytes))
    expect(f.getTransaction).toHaveBeenCalledWith(f.signature, expect.objectContaining({ commitment: 'finalized' }))
  })

  it('bounds a stalled RPC even if the transport ignores abort', async () => {
    const f = fixture()
    const hash = await messageFingerprint(f.transaction.messageBytes)
    vi.useFakeTimers()
    f.send.mockImplementation(() => new Promise(() => {}))
    const pending = verifySubmissionMessage(f.ctx, f.signature, hash)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await pending).toBeUndefined()
    expect(f.send.mock.calls[0]![0].abortSignal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})
