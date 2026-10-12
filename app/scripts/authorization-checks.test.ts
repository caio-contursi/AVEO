import {
  AccountRole, blockhash, generateKeyPairSigner, getAddressDecoder, getBase64Encoder, getTransactionDecoder, SolanaError,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_SIGNATURE_VERIFICATION_FAILURE,
  type Instruction,
} from '@solana/kit'
import { describe, expect, it, vi } from 'vitest'
import type { RawAccount } from '../src/api/accounts'
import type { ApiContext } from '../src/api/context'
import {
  AUTHORIZATION_STAGES, directExecuteInstruction, expectAuthorizationAccountUnchanged,
  isSignatureVerificationFailure, rejectUnsignedAuthority, runAuthorizationChecks,
} from './authorization-checks'

const addr = (byte: number) => getAddressDecoder().decode(new Uint8Array(32).fill(byte))
const signatureFailure = () => new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_SIGNATURE_VERIFICATION_FAILURE)
async function rawFixture(error: unknown = signatureFailure()) {
  const payer = await generateKeyPairSigner()
  const signer = { address: addr(2), signTransactions: vi.fn(() => { throw new Error('Forbidden signer invocation') }) }
  const accounts = [
    { address: signer.address, role: AccountRole.WRITABLE_SIGNER, signer },
    { address: addr(4), role: AccountRole.WRITABLE },
  ]
  const instruction: Instruction = { programAddress: addr(3), accounts, data: new Uint8Array([1]) }
  const submit = vi.fn().mockRejectedValue(error)
  const sendTransaction = vi.fn(() => ({ send: submit }))
  const simulateTransaction = vi.fn(() => { throw new Error('Forbidden simulation') })
  const ctx = { cluster: 'localnet', rpcUrl: 'http://127.0.0.1:8899', commitment: 'confirmed', rpc: {
    getLatestBlockhash: vi.fn(() => ({ send: async () => ({ value: {
      blockhash: blockhash(addr(5)), lastValidBlockHeight: 100n,
    } }) })), sendTransaction, simulateTransaction,
  } } as unknown as ApiContext
  return { ctx, instruction, signer, payer, submit, sendTransaction, simulateTransaction }
}

describe('T13 authorization acceptance', () => {
  it.each(['http://127.0.0.1:8899', 'http://localhost:8899/', 'http://[::1]:8899', 'https://localhost'])('accepts loopback root %s', async (rpcUrl) => {
    const f = await rawFixture()
    await rejectUnsignedAuthority({ ...f.ctx, rpcUrl }, f.instruction, f.payer, f.signer.address)
    expect(f.sendTransaction).toHaveBeenCalledOnce()
  })
  it.each(['https://api.devnet.solana.com', 'http://127.0.0.1.evil.test', 'http://user:secret@localhost:8899',
    'http://localhost:8899/?key=secret', 'http://localhost:8899/proxy', 'http://localhost:8899/#secret',
    'file:///localhost', 'invalid'])('both write exports reject unsafe endpoint before RPC %s', async (rpcUrl) => {
    const f = await rawFixture()
    const ctx = { ...f.ctx, rpcUrl }
    const reject = vi.fn()
    const emit = vi.fn()
    const completeStage = vi.fn()
    for (const operation of [
      () => rejectUnsignedAuthority(ctx, f.instruction, f.payer, f.signer.address),
      () => runAuthorizationChecks({ ctx, treasury: f.payer, x: f.payer, asset: { mint: addr(4) }, reject, emit, completeStage }),
    ]) {
      await expect(operation()).rejects.toThrow()
      try { await operation() } catch (error) {
        expect((error as Error).message).not.toContain(rpcUrl)
        expect((error as Error).message).not.toContain('secret')
      }
    }
    expect(f.ctx.rpc.getLatestBlockhash).not.toHaveBeenCalled()
    expect(f.sendTransaction).not.toHaveBeenCalled()
    expect(reject).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
    expect(completeStage).not.toHaveBeenCalled()
  })
  it('both write exports reject a nonlocal cluster even with a loopback endpoint', async () => {
    const f = await rawFixture()
    const ctx = { ...f.ctx, cluster: 'devnet' as const }
    await expect(rejectUnsignedAuthority(ctx, f.instruction, f.payer, f.signer.address)).rejects.toThrow('requires localnet')
    await expect(runAuthorizationChecks({ ctx, treasury: f.payer, x: f.payer, asset: { mint: addr(4) },
      reject: vi.fn(), emit: vi.fn(), completeStage: vi.fn() })).rejects.toThrow('requires localnet')
    expect(f.ctx.rpc.getLatestBlockhash).not.toHaveBeenCalled()
    expect(f.sendTransaction).not.toHaveBeenCalled()
  })
  it('requires the official specific validator failure, never text or arbitrary RPC errors', () => {
    expect(isSignatureVerificationFailure(signatureFailure())).toBe(true)
    for (const error of [new Error('Transaction signature verification failure'),
      { code: -32003 }, new Error('RPC unavailable'), null]) {
      expect(isSignatureVerificationFailure(error)).toBe(false)
    }
  })

  it('builds SPL Execute with u64 amount and the complete official account order', () => {
    const resolved = [...Array.from({ length: 9 }, (_, index) => ({ address: addr(index + 10), role: AccountRole.READONLY })),
      { address: addr(3), role: AccountRole.READONLY }, { address: addr(4), role: AccountRole.READONLY }]
    const instruction = directExecuteInstruction({ programId: addr(3), source: addr(1), mint: addr(2),
      destination: addr(5), owner: addr(6), validation: addr(4), resolved })
    expect(Array.from(instruction.data!)).toEqual([105, 37, 101, 197, 75, 251, 102, 26, 1, 0, 0, 0, 0, 0, 0, 0])
    expect(instruction.accounts?.map((meta) => meta.address)).toEqual([
      addr(1), addr(2), addr(5), addr(6), addr(4), ...resolved.slice(0, 9).map((meta) => meta.address),
    ])
    expect(instruction.programAddress).toBe(addr(3))
    expect(instruction.accounts?.every((meta) => meta.role === AccountRole.READONLY)).toBe(true)
    expect(() => directExecuteInstruction({ programId: addr(3), source: addr(1), mint: addr(2),
      destination: addr(5), owner: addr(6), validation: addr(4), resolved: resolved.slice(1) })).toThrow('all nine')
    expect(() => directExecuteInstruction({ programId: addr(3), source: addr(1), mint: addr(2),
      destination: addr(5), owner: addr(6), validation: addr(4), resolved: resolved.toReversed() })).toThrow('all nine')
  })

  it('checks token balance bytes and every protected account field, including existence', () => {
    const before: RawAccount = { address: addr(1), owner: addr(2), lamports: 10n, executable: false, data: new Uint8Array([1, 2]) }
    expect(() => expectAuthorizationAccountUnchanged(before, { ...before, data: before.data.slice() })).not.toThrow()
    for (const after of [null, { ...before, address: addr(3) }, { ...before, owner: addr(3) },
      { ...before, lamports: 11n }, { ...before, executable: true },
      { ...before, data: new Uint8Array([1, 3]) }, { ...before, data: new Uint8Array([1, 2, 0]) }]) {
      expect(() => expectAuthorizationAccountUnchanged(before, after)).toThrow()
    }
    expect(() => expectAuthorizationAccountUnchanged(null, null)).toThrow()
  })

  it('submits a valid payer signature with only the required authority missing, without signer discovery or simulation', async () => {
    const f = await rawFixture()
    await rejectUnsignedAuthority(f.ctx, f.instruction, f.payer, f.signer.address)
    expect(f.signer.signTransactions).not.toHaveBeenCalled()
    expect(f.simulateTransaction).not.toHaveBeenCalled()
    expect(f.sendTransaction).toHaveBeenCalledOnce()
    const [wire, options] = f.sendTransaction.mock.calls[0] as unknown as [string, unknown]
    expect(options).toEqual({ encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0n })
    const bytes = getBase64Encoder().encode(wire)
    expect(bytes[0]).toBe(2)
    expect(Array.from(bytes.slice(1, 65)).some((byte) => byte !== 0)).toBe(true)
    expect(Array.from(bytes.slice(65, 129)).every((byte) => byte === 0)).toBe(true)
    const decoded = getTransactionDecoder().decode(bytes)
    expect(Object.keys(decoded.signatures)).toEqual([f.payer.address, addr(2)])
    expect(decoded.signatures[addr(2)] === null || decoded.signatures[addr(2)]!.every((byte) => byte === 0)).toBe(true)
    expect(await crypto.subtle.verify('Ed25519', f.payer.keyPair.publicKey,
      new Uint8Array(decoded.signatures[f.payer.address]!), new Uint8Array(decoded.messageBytes))).toBe(true)
  })

  it.each([new Error('RPC offline'), new Error('Transaction signature verification failure'), { code: -32002 }])(
    'rejects nonspecific submission failures', async (error) => {
      const f = await rawFixture(error)
      await expect(rejectUnsignedAuthority(f.ctx, f.instruction, f.payer, f.signer.address)).rejects.toThrow('did not produce validator')
    },
  )
  it('rejects unexpected acceptance without inventing ledger confirmation', async () => {
    const f = await rawFixture()
    f.submit.mockResolvedValueOnce('unexpected signature')
    await expect(rejectUnsignedAuthority(f.ctx, f.instruction, f.payer, f.signer.address)).rejects.toThrow('unexpectedly accepted')
  })
  it('never submits when the authority is not a required signer', async () => {
    const f = await rawFixture()
    await expect(rejectUnsignedAuthority(f.ctx, f.instruction, f.payer, addr(9))).rejects.toThrow('empty signature slot')
    expect(f.sendTransaction).not.toHaveBeenCalled()
    expect(f.signer.signTransactions).not.toHaveBeenCalled()
  })
  it('never submits if another signature is missing besides the authority', async () => {
    const f = await rawFixture()
    const operation: Instruction = { ...f.instruction, accounts: [
      ...f.instruction.accounts!, { address: addr(8), role: AccountRole.READONLY_SIGNER },
    ] }
    await expect(rejectUnsignedAuthority(f.ctx, operation, f.payer, f.signer.address)).rejects.toThrow('Only the fee payer')
    expect(f.sendTransaction).not.toHaveBeenCalled()
    expect(f.signer.signTransactions).not.toHaveBeenCalled()
  })
  it('never submits or reads a blockhash when payer and omitted authority coincide', async () => {
    const f = await rawFixture()
    await expect(rejectUnsignedAuthority(f.ctx, f.instruction, f.payer, f.payer.address)).rejects.toThrow('distinct fee payer')
    expect(f.ctx.rpc.getLatestBlockhash).not.toHaveBeenCalled()
    expect(f.sendTransaction).not.toHaveBeenCalled()
  })
  it('exposes separate stages for the parent to complete only after unchanged readbacks', () => {
    expect(AUTHORIZATION_STAGES).toEqual(['direct-hook-execute-rejected', 'unsigned-policy-update-rejected', 'unsigned-binding-rejected'])
  })
})
