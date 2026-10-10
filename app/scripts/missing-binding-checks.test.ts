import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createNoopSigner, getAddressDecoder, getBase58Decoder, signature, type Address, type KeyPairSigner } from '@solana/kit'
import { findAssociatedTokenPda, getTokenEncoder, getMintEncoder, resolveExtraAccountMetasForExecute } from '@solana-program/token-2022'
import { readAccounts, type RawAccount } from '../src/api/accounts'
import { decodeEligibilityBinding } from '../src/api/codecs'
import { inspectEligibility } from '../src/api/eligibility'
import { AVEO_HOOK_PROGRAM_ID, SAS_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '../src/api/constants'
import { findBindingPda, findExtraAccountMetasPda, findPolicyPda } from '../src/api/pdas'
import { MISSING_BINDING_STAGES, MISSING_BINDING_TLV_ERROR, runMissingBindingChecks,
  MISSING_SOURCE_BINDING_STAGES, runMissingSourceBindingChecks, requireMissingSourceFixtureAccounting,
  type MissingSourceBindingChecksInput, type MissingBindingChecksInput } from './missing-binding-checks'

// Injected unit orchestration only: no RPC account injection is real-ledger evidence.
vi.mock('../src/api/accounts', () => ({ readAccounts: vi.fn() }))
vi.mock('../src/api/eligibility', () => ({ inspectEligibility: vi.fn() }))
vi.mock('../src/api/codecs', async (original) => ({
  ...await original<typeof import('../src/api/codecs')>(), decodeEligibilityBinding: vi.fn(),
}))
vi.mock('@solana-program/token-2022', async (original) => ({
  ...await original<typeof import('@solana-program/token-2022')>(), resolveExtraAccountMetasForExecute: vi.fn(),
}))
const addr = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n))
const signer = (n: number) => createNoopSigner(addr(n)) as unknown as KeyPairSigner
const sig = signature(getBase58Decoder().decode(new Uint8Array(64).fill(1)))
beforeEach(() => vi.resetAllMocks())

async function fixture() {
  const treasury = signer(1), x = signer(2), owner = addr(3)
  const assets = [4, 5].map((n, i) => ({ id: i ? 'beta' : 'alfa', mint: addr(n), decimals: 0, label: 'Unit', symbol: 'UNIT' }))
  const accounts = new Map<Address, RawAccount>()
  const bindings = new Map<number, ReturnType<typeof decodeEligibilityBinding>>()
  const raw = (address: Address, program: Address, data = new Uint8Array([1])): RawAccount =>
    ({ address, owner: program, executable: false, lamports: 100n, data })
  const token = (mint: Address, wallet: Address, amount: bigint) => new Uint8Array(getTokenEncoder().encode({
    mint, owner: wallet, amount, delegate: null, state: 1, isNative: null,
    delegatedAmount: 0n, closeAuthority: null, extensions: null,
  }))
  const destinations: Address[] = [], missing: Address[] = [], sources: Address[] = []
  for (const [i, asset] of assets.entries()) {
    accounts.set(asset.mint, raw(asset.mint, TOKEN_2022_PROGRAM_ID))
    for (const address of await Promise.all([findPolicyPda(AVEO_HOOK_PROGRAM_ID, asset.mint),
      findExtraAccountMetasPda(AVEO_HOOK_PROGRAM_ID, asset.mint)])) accounts.set(address, raw(address, AVEO_HOOK_PROGRAM_ID))
    const [source] = await findAssociatedTokenPda({ owner: treasury.address, mint: asset.mint, tokenProgram: TOKEN_2022_PROGRAM_ID })
    sources.push(source)
    accounts.set(source, raw(source, TOKEN_2022_PROGRAM_ID, token(asset.mint, treasury.address, 10n)))
    destinations.push((await findAssociatedTokenPda({ owner, mint: asset.mint, tokenProgram: TOKEN_2022_PROGRAM_ID }))[0])
    missing.push(await findBindingPda(AVEO_HOOK_PROGRAM_ID, asset.mint, owner))
    for (const [j, wallet] of [treasury.address, x.address].entries()) {
      const key = 10 + i * 2 + j
      const address = await findBindingPda(AVEO_HOOK_PROGRAM_ID, asset.mint, wallet)
      const binding = { version: 2, mint: asset.mint, subjectWallet: wallet,
        credential: addr(key + 30), schema: addr(key + 40), attestation: addr(key + 50), bump: 1 }
      bindings.set(key, binding)
      accounts.set(address, raw(address, AVEO_HOOK_PROGRAM_ID, new Uint8Array([key])))
      for (const a of [binding.credential, binding.schema, binding.attestation]) accounts.set(a, raw(a, SAS_PROGRAM_ID))
    }
  }
  vi.mocked(decodeEligibilityBinding).mockImplementation((data) => bindings.get(data[0]!)!)
  let slot = 10
  let ledgerError: unknown = null
  vi.mocked(readAccounts).mockImplementation(async (_ctx, addresses, floor) => {
    expect(floor).toBeLessThanOrEqual(slot)
    return { slot, accounts: addresses.map((address) => {
      const account = accounts.get(address)
      return account ? { ...account, data: account.data.slice() } : null
    }) }
  })
  vi.mocked(resolveExtraAccountMetasForExecute).mockImplementation(async (args) => {
    const i = assets.findIndex((asset) => asset.mint === args.mint)
    throw new Error(`Invalid transfer hook pubkey data: account ${missing[i]} was not found.`)
  })
  const input = {
    ctx: { cluster: 'localnet', rpcUrl: 'http://localhost:8899', commitment: 'confirmed', programId: AVEO_HOOK_PROGRAM_ID,
      rpc: { getSignatureStatuses: vi.fn(() => ({ send: async () => ({ value: [{ slot: BigInt(slot),
        err: ledgerError, confirmationStatus: 'confirmed' }] }) })) } },
    deployment: { cluster: 'localnet', programs: { aveoHook: AVEO_HOOK_PROGRAM_ID, sas: SAS_PROGRAM_ID,
      token2022: TOKEN_2022_PROGRAM_ID }, verifiers: [] },
    assets, treasury, x, issuer: signer(6), verifier: signer(7), nonce: vi.fn(async () => owner),
    send: vi.fn(async () => {
      slot += 1
      assets.forEach((asset, i) => accounts.set(destinations[i]!, raw(destinations[i]!, TOKEN_2022_PROGRAM_ID, token(asset.mint, owner, 0n))))
      return sig
    }),
    reject: vi.fn(), transfer: vi.fn(), emit: vi.fn(), complete: vi.fn(),
    rejectMissingBinding: vi.fn(async () => {
      slot += 5
      ledgerError = { InstructionError: [1, { Custom: MISSING_BINDING_TLV_ERROR }] }
      return { signature: sig, status: 'failed', slot, err: ledgerError,
        logs: [`Program ${TOKEN_2022_PROGRAM_ID} failed: custom program error: 0x${MISSING_BINDING_TLV_ERROR.toString(16)}`] }
    }),
  } as unknown as MissingBindingChecksInput
  return { input, accounts, missing, destinations, sources, raw, token, bindings,
    getSlot: () => slot, setLedgerError: (error: unknown) => { ledgerError = error } }
}

const mintData = (supply = 1001n, authority: Address | null = null) => new Uint8Array(getMintEncoder().encode({
  mintAuthority: authority, supply, decimals: 0, isInitialized: true, freezeAuthority: null, extensions: null,
}))

async function sourceFixture() {
  const f = await fixture()
  const sourceSigner = signer(3)
  const missing: Address[] = [], sources: Address[] = []
  for (const asset of f.input.assets) {
    const [source] = await findAssociatedTokenPda({ owner: sourceSigner.address, mint: asset.mint, tokenProgram: TOKEN_2022_PROGRAM_ID })
    sources.push(source)
    missing.push(await findBindingPda(AVEO_HOOK_PROGRAM_ID, asset.mint, sourceSigner.address))
    f.accounts.set(source, f.raw(source, TOKEN_2022_PROGRAM_ID, f.token(asset.mint, sourceSigner.address, 1n)))
    f.accounts.set(asset.mint, f.raw(asset.mint, TOKEN_2022_PROGRAM_ID, mintData()))
  }
  vi.mocked(resolveExtraAccountMetasForExecute).mockImplementation(async (args) => {
    const i = f.input.assets.findIndex((a) => a.mint === args.mint)
    throw new Error(`Invalid transfer hook pubkey data: account ${missing[i]} was not found.`)
  })
  vi.mocked(inspectEligibility).mockImplementation(async (_ctx, mint, wallet) => {
    const i = f.input.assets.findIndex((a) => a.mint === mint), proof = f.bindings.get(10 + i * 2)!
    return { verdict: 'eligible', mint, wallet, reasons: [], read: { slot: f.getSlot() },
      sourceAccounts: { policy: await findPolicyPda(AVEO_HOOK_PROGRAM_ID, mint),
        binding: await findBindingPda(AVEO_HOOK_PROGRAM_ID, mint, wallet), ...proof } } as never
  })
  let transaction: unknown
  const reject = f.input.rejectMissingBinding
  const input: MissingSourceBindingChecksInput = { ...f.input, sourceSigner, guardLocalnet: vi.fn(async () => {}),
    rejectMissingBinding: vi.fn(async (payer, instructions) => {
      const result = await reject(payer, instructions)
      transaction = { slot: BigInt(result.slot), transaction: { signatures: [result.signature] },
        meta: { err: result.err, logMessages: result.logs } }
      return result
    }) }
  input.ctx.rpc = { ...input.ctx.rpc, getTransaction: vi.fn(() => ({ send: async () => transaction })) } as never
  return { ...f, input, missing, sources, setTransaction: (value: unknown) => { transaction = value } }
}

describe('missing binding orchestration (mocked unit evidence only)', () => {
  it.each(['remote', 'credentials', 'path', 'query', 'processed', 'devnet', 'hook', 'sas', 'token', 'duplicate', 'callback'])(
    'rejects unsafe %s before nonce, reads or transactions', async (kind) => {
      const { input } = await fixture()
      const reject = input.rejectMissingBinding
      if (kind === 'remote') input.ctx.rpcUrl = 'https://api.devnet.solana.com'
      if (kind === 'credentials') input.ctx.rpcUrl = 'http://user:pass@localhost:8899'
      if (kind === 'path') input.ctx.rpcUrl = 'http://localhost:8899/proxy'
      if (kind === 'query') input.ctx.rpcUrl = 'http://localhost:8899/?key=unit'
      if (kind === 'processed') input.ctx.commitment = 'processed'
      if (kind === 'devnet') input.deployment.cluster = 'devnet'
      if (kind === 'hook') input.ctx.programId = addr(80)
      if (kind === 'sas') input.deployment.programs.sas = addr(80)
      if (kind === 'token') input.deployment.programs.token2022 = addr(80)
      if (kind === 'duplicate') input.assets[1] = input.assets[0]!
      if (kind === 'callback') input.rejectMissingBinding = undefined as never
      await expect(runMissingBindingChecks(input)).rejects.toThrow()
      expect(input.nonce).not.toHaveBeenCalled()
      expect(readAccounts).not.toHaveBeenCalled()
      expect(input.send).not.toHaveBeenCalled()
      expect(reject).not.toHaveBeenCalled()
    })

  it('orders stages, keeps correct absent PDA and metas, and emits no invented hook code', async () => {
    const f = await fixture()
    await runMissingBindingChecks(f.input)
    expect(vi.mocked(f.input.complete).mock.calls.flat()).toEqual([...MISSING_BINDING_STAGES])
    expect(resolveExtraAccountMetasForExecute).toHaveBeenCalledTimes(2)
    expect(f.input.rejectMissingBinding).toHaveBeenCalledTimes(2)
    for (const [i, [payer, instructions]] of vi.mocked(f.input.rejectMissingBinding).mock.calls.entries()) {
      expect(payer).toBe(f.input.treasury)
      expect(instructions).toHaveLength(1)
      expect(instructions[0]!.programAddress).toBe(TOKEN_2022_PROGRAM_ID)
      expect(instructions[0]!.accounts).toHaveLength(15)
      expect(instructions[0]!.accounts![6]!.address).toBe(f.missing[i])
      expect(f.accounts.has(f.missing[i]!)).toBe(false)
    }
    expect(vi.mocked(f.input.emit).mock.calls.every(([e]) => e.hookCode === undefined)).toBe(true)
    expect(f.input.transfer).not.toHaveBeenCalled()
    expect(f.input.reject).not.toHaveBeenCalled()
  })

  it('rejects an already existing destination binding before ATA creation', async () => {
    const f = await fixture()
    f.accounts.set(f.missing[0]!, { address: f.missing[0]!, owner: AVEO_HOOK_PROGRAM_ID,
      executable: false, lamports: 1n, data: new Uint8Array() })
    await expect(runMissingBindingChecks(f.input)).rejects.toThrow('must be absent')
    expect(f.input.send).not.toHaveBeenCalled()
  })

  it.each(['wrong-code', 'wrong-index', 'wrong-logs', 'slot-mismatch', 'unconfirmed', 'raw-mismatch', 'success'])(
    'refuses %s ledger results without completing rejection stage', async (kind) => {
      const f = await fixture(), reject = f.input.rejectMissingBinding
      f.input.rejectMissingBinding = async (payer, instructions) => {
        const result = await reject(payer, instructions)
        if (kind === 'wrong-code' || kind === 'wrong-index') {
          result.err = { InstructionError: [kind === 'wrong-index' ? 0 : 1, { Custom: kind === 'wrong-code' ? 1 : MISSING_BINDING_TLV_ERROR }] }
          f.setLedgerError(result.err)
        }
        if (kind === 'wrong-logs') result.logs = ['RPC unavailable']
        if (kind === 'slot-mismatch') result.slot += 1
        if (kind === 'raw-mismatch') result.err = {}
        if (kind === 'success') f.setLedgerError(null)
        if (kind === 'unconfirmed') vi.mocked(f.input.ctx.rpc.getSignatureStatuses).mockReturnValue({
          send: async () => ({ value: [{ slot: 16n, err: result.err, confirmationStatus: 'processed' }] }),
        } as never)
        return result
      }
      await expect(runMissingBindingChecks(f.input)).rejects.toThrow('Missing binding checks or protected readback failed')
      expect(f.input.complete).not.toHaveBeenCalledWith(MISSING_BINDING_STAGES[1])
      expect(f.input.complete).not.toHaveBeenCalledWith(MISSING_BINDING_STAGES[2])
    })

  it.each(['balance', 'binding', 'callback', 'resolver'])(
    'detects %s mutation/failure and does not complete final stage', async (kind) => {
      const f = await fixture(), reject = f.input.rejectMissingBinding
      if (kind === 'resolver') vi.mocked(resolveExtraAccountMetasForExecute).mockRejectedValue(new Error('RPC unavailable'))
      f.input.rejectMissingBinding = async (payer, instructions) => {
        const result = await reject(payer, instructions)
        if (kind === 'balance') f.accounts.get(f.sources[0]!)!.data[64] = 9
        if (kind === 'binding') f.accounts.set(f.missing[0]!, { ...f.accounts.get(f.sources[0]!)!, address: f.missing[0]! })
        if (kind === 'callback') throw new Error('Injected post-submission callback failure')
        return result
      }
      await expect(runMissingBindingChecks(f.input)).rejects.toThrow('Missing binding checks or protected readback failed')
      expect(f.input.complete).not.toHaveBeenCalledWith(MISSING_BINDING_STAGES[2])
      if (kind === 'resolver') expect(reject).not.toHaveBeenCalled()
    })
})

describe('SEC-09 missing source binding (mocked unit evidence only)', () => {
  it('requires both funded source cases, exact missing source metas, ledger matches and fresh protected readback', async () => {
    const f = await sourceFixture()
    await runMissingSourceBindingChecks(f.input)
    expect(vi.mocked(f.input.complete).mock.calls.flat()).toEqual([...MISSING_SOURCE_BINDING_STAGES])
    expect(f.input.guardLocalnet).toHaveBeenCalledTimes(3)
    expect(f.input.send).not.toHaveBeenCalled()
    expect(f.input.nonce).not.toHaveBeenCalled()
    expect(f.input.ctx.rpc.getTransaction).toHaveBeenCalledTimes(2)
    for (const [i, [payer, instructions]] of vi.mocked(f.input.rejectMissingBinding).mock.calls.entries()) {
      expect(payer).toBe(f.input.sourceSigner)
      expect(instructions).toHaveLength(1)
      expect(instructions[0]!.accounts).toHaveLength(15)
      expect(instructions[0]!.accounts![0]!.address).toBe(f.sources[i])
      expect(instructions[0]!.accounts![5]!.address).toBe(f.missing[i])
      expect(instructions[0]!.accounts![6]!.address).toBe(await findBindingPda(AVEO_HOOK_PROGRAM_ID, f.input.assets[i]!.mint, f.input.treasury.address))
    }
    const evidence = vi.mocked(f.input.emit).mock.calls.map(([entry]) => entry)
    expect(evidence.filter((entry) => entry.accepted === false)).toHaveLength(2)
    expect(evidence.every((entry) => entry.hookCode === undefined)).toBe(true)
    expect(evidence.filter((entry) => entry.accountUnchanged).every((entry) => entry.slot! >= f.getSlot())).toBe(true)
    expect(vi.mocked(readAccounts).mock.calls.slice(-2).every((call) => call[2]! >= f.getSlot())).toBe(true)
  })

  it.each(['remote', 'processed', 'public-cluster', 'same-owner', 'missing-guard', 'genesis', 'duplicate-mint'])(
    'stops unsafe %s before any source reads or signing', async (kind) => {
      const f = await sourceFixture()
      if (kind === 'remote') f.input.ctx.rpcUrl = 'https://api.devnet.solana.com'
      if (kind === 'processed') f.input.ctx.commitment = 'processed'
      if (kind === 'public-cluster') f.input.deployment.cluster = 'devnet'
      if (kind === 'same-owner') f.input.sourceSigner = f.input.treasury
      if (kind === 'missing-guard') f.input.guardLocalnet = undefined as never
      if (kind === 'genesis') vi.mocked(f.input.guardLocalnet).mockRejectedValue(new Error('Wrong genesis'))
      if (kind === 'duplicate-mint') f.input.assets[1]!.mint = f.input.assets[0]!.mint
      await expect(runMissingSourceBindingChecks(f.input)).rejects.toThrow()
      expect(readAccounts).not.toHaveBeenCalled()
      expect(f.input.rejectMissingBinding).not.toHaveBeenCalled()
    })

  it.each(['empty', 'wrong-owner', 'wrong-mint', 'existing-binding', 'invalid-destination', 'stale-destination',
    'wrong-proof', 'wrong-resolver', 'wrong-supply', 'mint-authority'])(
    'rejects %s fixture/precondition before signing', async (kind) => {
      const f = await sourceFixture(), asset = f.input.assets[0]!, source = f.accounts.get(f.sources[0]!)!
      if (['empty', 'wrong-owner', 'wrong-mint'].includes(kind)) source.data = f.token(
        kind === 'wrong-mint' ? addr(90) : asset.mint,
        kind === 'wrong-owner' ? f.input.treasury.address : f.input.sourceSigner.address, kind === 'empty' ? 0n : 1n)
      if (kind === 'existing-binding') f.accounts.set(f.missing[0]!, { ...source, address: f.missing[0]! })
      if (kind === 'invalid-destination') vi.mocked(inspectEligibility).mockResolvedValue({ verdict: 'ineligible', reasons: [] } as never)
      const inspect = vi.mocked(inspectEligibility).getMockImplementation()!
      if (kind === 'stale-destination' || kind === 'wrong-proof') vi.mocked(inspectEligibility).mockImplementation(async (...args) => {
        const snapshot = await inspect(...args)
        if (kind === 'stale-destination') snapshot.read.slot = 0
        if (kind === 'wrong-proof') snapshot.sourceAccounts.attestation = addr(90)
        return snapshot
      })
      if (kind === 'wrong-resolver') vi.mocked(resolveExtraAccountMetasForExecute).mockRejectedValue(new Error('RPC timeout'))
      if (kind === 'wrong-supply' || kind === 'mint-authority') f.accounts.get(asset.mint)!.data = mintData(kind === 'wrong-supply' ? 1000n : 1001n, kind === 'mint-authority' ? f.input.issuer.address : null)
      await expect(runMissingSourceBindingChecks(f.input)).rejects.toThrow()
      expect(f.input.rejectMissingBinding).not.toHaveBeenCalled()
      expect(f.input.complete).not.toHaveBeenCalledWith(MISSING_SOURCE_BINDING_STAGES[0])
    })

  it.each(['wrong-index', 'wrong-code', 'wrong-logs', 'slot', 'raw-error', 'success', 'processed',
    'transaction-signature', 'transaction-slot', 'transaction-error', 'transaction-logs', 'transaction-missing', 'hook-invoked'])(
    'refuses %s evidence and never completes rejection/integrity stages', async (kind) => {
      const f = await sourceFixture(), reject = f.input.rejectMissingBinding
      f.input.rejectMissingBinding = async (payer, instructions) => {
        const result = await reject(payer, instructions)
        if (kind === 'wrong-index' || kind === 'wrong-code') {
          result.err = { InstructionError: [kind === 'wrong-index' ? 0 : 1, { Custom: kind === 'wrong-code' ? 1 : MISSING_BINDING_TLV_ERROR }] }
          f.setLedgerError(result.err)
        }
        if (kind === 'wrong-logs') result.logs = ['RPC unavailable']
        if (kind === 'hook-invoked') result.logs.push(`Program ${AVEO_HOOK_PROGRAM_ID} invoke [2]`)
        if (kind === 'slot') result.slot += 1
        if (kind === 'raw-error') result.err = {}
        if (kind === 'success') f.setLedgerError(null)
        if (kind === 'processed') vi.mocked(f.input.ctx.rpc.getSignatureStatuses).mockReturnValue({ send: async () => ({ value: [{ slot: BigInt(result.slot), err: result.err, confirmationStatus: 'processed' }] }) } as never)
        f.setTransaction(kind === 'transaction-missing' ? null : {
          slot: BigInt(result.slot + (kind === 'transaction-slot' ? 1 : 0)),
          transaction: { signatures: [kind === 'transaction-signature' ? 'other' : result.signature] },
          meta: { err: kind === 'transaction-error' ? {} : result.err,
            logMessages: kind === 'transaction-logs' ? ['other'] : result.logs },
        })
        return result
      }
      await expect(runMissingSourceBindingChecks(f.input)).rejects.toThrow('Missing source binding checks or protected readback failed')
      expect(f.input.complete).not.toHaveBeenCalledWith(MISSING_SOURCE_BINDING_STAGES[1])
      expect(f.input.complete).not.toHaveBeenCalledWith(MISSING_SOURCE_BINDING_STAGES[2])
    })

  it.each(['source-balance', 'destination-balance', 'binding-created', 'policy-bytes', 'stale-read', 'post-send-failure', 'second-guard'])(
    'detects %s and observes protected integrity without claiming completion', async (kind) => {
      const f = await sourceFixture(), reject = f.input.rejectMissingBinding
      if (kind === 'second-guard') vi.mocked(f.input.guardLocalnet).mockResolvedValueOnce().mockRejectedValue(new Error('Changed genesis'))
      f.input.rejectMissingBinding = async (payer, instructions) => {
        const result = await reject(payer, instructions)
        if (kind === 'source-balance') f.accounts.get(f.sources[0]!)!.data[64] = 0
        if (kind === 'destination-balance') f.accounts.get((await findAssociatedTokenPda({ owner: f.input.treasury.address, mint: f.input.assets[0]!.mint, tokenProgram: TOKEN_2022_PROGRAM_ID }))[0])!.data[64] = 11
        if (kind === 'binding-created') f.accounts.set(f.missing[0]!, { ...f.accounts.get(f.sources[0]!)!, address: f.missing[0]! })
        if (kind === 'policy-bytes') f.accounts.get(await findPolicyPda(AVEO_HOOK_PROGRAM_ID, f.input.assets[0]!.mint))!.data[0] = 99
        if (kind === 'stale-read') vi.mocked(readAccounts).mockResolvedValue({ slot: 0, accounts: [] })
        if (kind === 'post-send-failure') throw new Error('Post submission failure')
        return result
      }
      await expect(runMissingSourceBindingChecks(f.input)).rejects.toThrow('Missing source binding checks or protected readback failed')
      expect(f.input.complete).not.toHaveBeenCalledWith(MISSING_SOURCE_BINDING_STAGES[2])
      if (kind === 'second-guard') expect(reject).not.toHaveBeenCalled()
    })

  it('accepts an actual hook BindingMissing only with matching raw error and hook failure logs', async () => {
    const f = await sourceFixture(), reject = f.input.rejectMissingBinding
    f.input.rejectMissingBinding = async (payer, instructions) => {
      const result = await reject(payer, instructions)
      result.err = { InstructionError: [1, { Custom: 6003 }] }
      result.logs = [`Program ${AVEO_HOOK_PROGRAM_ID} invoke [2]`,
        'Program log: AnchorError occurred. Error Code: BindingMissing. Error Number: 6003. Error Message: missing binding.',
        `Program ${AVEO_HOOK_PROGRAM_ID} failed: custom program error: 0x1773`]
      f.setLedgerError(result.err)
      f.setTransaction({ slot: BigInt(result.slot), transaction: { signatures: [result.signature] }, meta: { err: result.err, logMessages: result.logs } })
      return result
    }
    await runMissingSourceBindingChecks(f.input)
    expect(vi.mocked(f.input.emit).mock.calls.filter(([entry]) => entry.hookCode === 'BindingMissing')).toHaveLength(2)
  })
})

describe('SEC-09 fixture issuance accounting', () => {
  it.each(['valid', 'supply', 'authority', 'source-amount', 'treasury-amount', 'existing-holder', 'owner', 'mint', 'program', 'missing'])(
    'decodes and validates actual mint and all balances: %s', async (kind) => {
      const f = await fixture(), asset = f.input.assets[0]!
      const owners = [1, 2, 3, 4, 5].map(addr), atas = [80, 81, 82, 83, 84].map(addr)
      const accounts: (RawAccount | null)[] = [f.raw(asset.mint, TOKEN_2022_PROGRAM_ID,
        mintData(kind === 'supply' ? 1000n : 1001n, kind === 'authority' ? addr(99) : null)),
      ...owners.map((owner, i) => f.raw(atas[i]!, TOKEN_2022_PROGRAM_ID,
        f.token(kind === 'mint' ? addr(99) : asset.mint, kind === 'owner' ? addr(99) : owner,
          i === 0 ? (kind === 'treasury-amount' ? 999n : 1000n) : i === 4 ? (kind === 'source-amount' ? 0n : 1n) : (kind === 'existing-holder' ? 1n : 0n))))]
      if (kind === 'program') accounts[0]!.owner = SAS_PROGRAM_ID
      if (kind === 'missing') accounts[5] = null
      const check = () => requireMissingSourceFixtureAccounting(asset, accounts, owners, atas)
      if (kind === 'valid') expect(check).not.toThrow()
      else expect(check).toThrow()
    })
})
