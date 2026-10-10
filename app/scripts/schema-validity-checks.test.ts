import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createNoopSigner, getAddressDecoder, getBase58Decoder, signature, type Address, type KeyPairSigner, type UnixTimestamp } from '@solana/kit'
import { getSysvarClockEncoder } from '@solana/sysvars'
import { getCreateAttestationInstructionDataDecoder } from 'sas-lib'
import { readAccounts, type RawAccount } from '../src/api/accounts'
import { decodeEligibilityBinding, decodeSasAttestation, decodeSasCredential, decodeSasSchema } from '../src/api/codecs'
import { SAS_PROGRAM_ID, SYSVAR_CLOCK_ID } from '../src/api/constants'
import { findBindingPda, findPolicyPda } from '../src/api/pdas'
import type { AdversarialContext } from './adversarial-context'
import { proofIsLive, runSchemaValidityChecks, SCHEMA_VALIDITY_STAGES } from './schema-validity-checks'

vi.mock('../src/api/accounts', () => ({ readAccounts: vi.fn() }))
vi.mock('../src/api/codecs', async (original) => ({
  ...await original<typeof import('../src/api/codecs')>(),
  decodeEligibilityBinding: vi.fn(), decodeSasAttestation: vi.fn(),
  decodeSasCredential: vi.fn(), decodeSasSchema: vi.fn(), isAveoEligibilityV2: () => true,
}))

const addr = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n))
const signer = (n: number) => createNoopSigner(addr(n)) as unknown as KeyPairSigner
beforeEach(() => vi.clearAllMocks())

async function fixture() {
  const x = signer(1), treasury = signer(2), verifier = signer(3)
  const programId = addr(4), credential = addr(5), schema = addr(6)
  const assets = [7, 8].map((n, i) => ({ mint: addr(n), id: i ? 'beta' : 'alfa', label: 'Fixture', symbol: 'TEST', decimals: 0 }))
  const bindingAddresses = await Promise.all(assets.map((asset) => findBindingPda(programId, asset.mint, x.address)))
  const policies = await Promise.all(assets.map((asset) => findPolicyPda(programId, asset.mint)))
  const accounts = new Map<Address, RawAccount>()
  const proofs = new Map<Address, ReturnType<typeof decodeSasAttestation>>()
  const bindings = new Map<number, ReturnType<typeof decodeEligibilityBinding>>()
  const raw = (address: Address, owner: Address, data: number[]) => ({ address, owner, data: new Uint8Array(data), executable: false, lamports: 100n })
  bindingAddresses.forEach((address, i) => {
    accounts.set(address, raw(address, programId, [i + 10, 20 + i]))
    bindings.set(i + 10, { version: 2, mint: assets[i]!.mint, subjectWallet: x.address,
      credential, schema, attestation: addr(20 + i), bump: 1 })
  })
  policies.forEach((address) => accounts.set(address, raw(address, programId, [30])))
  accounts.set(credential, raw(credential, SAS_PROGRAM_ID, [40]))
  accounts.set(schema, raw(schema, SAS_PROGRAM_ID, [50, 0]))
  vi.mocked(decodeEligibilityBinding).mockImplementation((data) => ({ ...bindings.get(data[0]!)! }))
  vi.mocked(decodeSasSchema).mockImplementation((data) => ({ credential, isPaused: data[1] === 1,
    name: new Uint8Array(), description: new Uint8Array(), layout: new Uint8Array(), fieldNames: new Uint8Array(), version: 1 }))
  vi.mocked(decodeSasCredential).mockReturnValue({ authority: verifier.address, authorizedSigners: [verifier.address], name: new Uint8Array() })
  vi.mocked(decodeSasAttestation).mockImplementation((data) => [...proofs.values()].find((proof) => Number(proof.expiry % 256n) === data[0])!)
  let slot = 10, clock = 1000n, nonce = 60, liveRead = false, frozenClock = false
  let fail: string | undefined
  const sent: number[] = []
  const initial = new Map([...accounts].map(([address, account]) => [address, { ...account, data: account.data.slice() }]))
  vi.mocked(readAccounts).mockImplementation(async (_ctx, addresses, minSlot) => {
    expect(slot).toBeGreaterThanOrEqual(minSlot ?? 0)
    return { slot, accounts: addresses.map((address) => {
      if (address === SYSVAR_CLOCK_ID) {
        const short = [...proofs.values()].find((proof) => proof.expiry > 0n)
        if (short && [...bindings.values()].every((binding) => proofs.has(binding.attestation))) {
          if (liveRead && !frozenClock) clock = short.expiry + 1n
          liveRead = true
        }
        return { ...raw(address, addr(9), []), data: new Uint8Array(getSysvarClockEncoder().encode({
          slot: BigInt(slot), epochStartTimestamp: 0n as UnixTimestamp, epoch: 0n,
          leaderScheduleEpoch: 0n, unixTimestamp: clock as UnixTimestamp,
        })) }
      }
      const account = accounts.get(address)
      return account ? { ...account, data: account.data.slice() } : null
    }) }
  })
  const input = {
    ctx: { cluster: 'localnet', rpcUrl: 'http://localhost:8899', commitment: 'confirmed', programId,
      rpc: { getSignatureStatuses: () => ({ send: async () => ({ value: [{ slot: BigInt(slot), err: null, confirmationStatus: 'confirmed' }] }) }) } },
    deployment: { cluster: 'localnet', programs: { aveoHook: programId, sas: SAS_PROGRAM_ID }, proofDomain: '01'.repeat(32),
      verifiers: [{ authority: verifier.address, credential, schema }] },
    assets, x, treasury, verifier, issuer: signer(9), nonce: async () => addr(nonce++),
    send: vi.fn(async (_payer, instructions) => {
      slot += 1
      for (const ix of instructions) {
        const kind = ix.programAddress === SAS_PROGRAM_ID ? ix.data![0]! : 99
        sent.push(kind)
        if (kind === 2) accounts.get(schema)!.data[1] = ix.data![1]!
        if (kind === 6) {
          const data = getCreateAttestationInstructionDataDecoder().decode(ix.data!)
          const proof = ix.accounts![4]!.address
          proofs.set(proof, { ...data, credential, schema, signer: verifier.address, tokenAccount: addr(0) })
          accounts.set(proof, raw(proof, SAS_PROGRAM_ID, [Number(data.expiry % 256n)]))
        }
        if (kind === 7) { accounts.delete(ix.accounts![3]!.address); proofs.delete(ix.accounts![3]!.address) }
        if (kind === 99) {
          const address = ix.accounts![3]!.address
          const account = accounts.get(address)!
          bindings.get(account.data[0]!)!.attestation = ix.accounts![6]!.address
          account.data[1] = ix.accounts![6]!.address === addr(20 + bindingAddresses.indexOf(address)) ? 20 + bindingAddresses.indexOf(address) : 90
        }
        if (fail === `send-${kind}`) { fail = undefined; throw new Error('Injected post-send failure') }
      }
      return signature(getBase58Decoder().decode(new Uint8Array(64).fill(1)))
    }),
    reject: vi.fn(async () => {
      if (fail === 'reject') throw new Error('Injected rejection failure')
      slot += 10
      return { status: 'failed', slot, logs: ['Program log: AttestationExpired'] }
    }),
    transfer: vi.fn(async () => { if (fail === 'transfer') throw new Error('Injected transfer failure') }),
    emit: vi.fn(() => { if (fail === 'emit') throw new Error('Injected reporting failure') }),
    complete: vi.fn((id) => { if (fail === id) throw new Error('Injected completion failure') }),
  } as unknown as AdversarialContext
  const assertRestored = () => {
    for (const [address, original] of initial) expect(accounts.get(address)).toEqual(original)
    expect(proofs.size).toBe(0)
  }
  return { input, sent, accounts, initial, proofs, bindingAddresses, assertRestored,
    freezeClock: () => { frozenClock = true }, setFailure: (value: string) => { fail = value } }
}

describe('strict expiry boundary used by the runner', () => {
  it.each([[0n, 100n, false], [100n, 100n, false], [99n, 100n, false], [101n, 100n, true]] as const)(
    'expiry %s at Clock %s is live=%s (unit evidence only)', (expiry, clock, expected) => {
      expect(proofIsLive(expiry, clock)).toBe(expected)
    })
})

describe('injected schema validity orchestration; no real transactions', () => {
  it('floors all four unchanged-binding reads at their confirmed rejection slots', async () => {
    const f = await fixture()
    const reject = f.input.reject
    const read = vi.mocked(readAccounts).getMockImplementation()!
    let pending: { address: Address; slot: number } | undefined
    const checkedFloors: number[] = []
    f.input.reject = async (payer, instructions, code) => {
      const result = await reject(payer, instructions, code) as { slot: number }
      pending = { address: instructions[0]!.accounts![3]!.address, slot: result.slot }
      return result
    }
    vi.mocked(readAccounts).mockImplementation(async (ctx, addresses, floor, timeout) => {
      if (pending) {
        expect(addresses).toEqual([pending.address])
        expect(floor).toBeGreaterThanOrEqual(pending.slot)
        checkedFloors.push(floor!)
        pending = undefined
      }
      return read(ctx, addresses, floor, timeout)
    })
    await runSchemaValidityChecks(f.input)
    expect(checkedFloors).toHaveLength(4)
    expect(checkedFloors.every((floor, i) => i === 0 || floor > checkedFloors[i - 1]!)).toBe(true)
    f.assertRestored()
  })
  it.each(['zero', 'expired'] as const)('rejects malformed %s binding ledger results without passing the case', async (boundary) => {
    const malformed = [undefined, null, {}, { ok: false },
      { status: 'confirmed', slot: 100, logs: ['failure'] },
      { status: 'unknown', slot: 100, logs: ['failure'] },
      { status: 'failed', logs: ['failure'] },
      ...[-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '100', 100n].map((slot) =>
        ({ status: 'failed', slot, logs: ['failure'] })),
      ...[undefined, null, [], [''], [null], ['failure', 1], 'failure'].map((logs) =>
        ({ status: 'failed', slot: 100, logs })),
    ]
    for (const result of malformed) {
      const f = await fixture()
      const reject = f.input.reject
      let calls = 0
      f.input.reject = async (payer, instructions, code) => {
        calls += 1
        return calls === (boundary === 'zero' ? 1 : 3) ? result : reject(payer, instructions, code)
      }
      const error = await runSchemaValidityChecks(f.input).then(() => undefined, (error: unknown) => error)
      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors).toContainEqual(expect.objectContaining({
        message: 'Expected confirmed failed ledger observation with valid slot and logs',
      }))
      expect(f.input.complete).not.toHaveBeenCalledWith(SCHEMA_VALIDITY_STAGES[boundary === 'zero' ? 3 : 5])
      expect(f.input.complete).not.toHaveBeenCalledWith(SCHEMA_VALIDITY_STAGES[6])
      f.assertRestored()
    }
  })
  it('orders stages, tests both directions/assets, rejects both zero binds and restores original state', async () => {
    const f = await fixture()
    await runSchemaValidityChecks(f.input)
    expect(vi.mocked(f.input.complete).mock.calls.flat()).toEqual([...SCHEMA_VALIDITY_STAGES])
    expect(vi.mocked(f.input.transfer).mock.calls.map(([asset, dest, accepted, code, payer]) =>
      [asset.id, dest, accepted, code, payer?.address])).toEqual(
      ['SchemaMismatchOrPaused', 'AttestationExpired'].flatMap((code) => f.input.assets.flatMap((asset) => [
        [asset.id, f.input.x.address, false, code, undefined],
        [asset.id, f.input.treasury.address, false, code, f.input.x.address],
      ])))
    expect(f.input.reject).toHaveBeenCalledTimes(4)
    expect(vi.mocked(f.input.reject).mock.calls.every(([, , code]) => code === 'AttestationExpired')).toBe(true)
    expect(SCHEMA_VALIDITY_STAGES.some((id) => id.includes('equality'))).toBe(false)
    expect(vi.mocked(f.input.emit).mock.calls.some(([e]) => e.expiry! > 0 && e.clockUnix! > e.expiry!)).toBe(true)
    expect(vi.mocked(f.input.emit).mock.calls.filter(([e]) => e.schemaPaused !== undefined).map(([e]) =>
      [e.schemaPaused, e.accountUnchanged])).toEqual([[true, false], [false, true]])
    f.assertRestored()
  })
  it.each(['send-2', 'send-6', 'send-99', 'transfer', 'reject', 'emit',
    SCHEMA_VALIDITY_STAGES[0], SCHEMA_VALIDITY_STAGES[3], SCHEMA_VALIDITY_STAGES[4], SCHEMA_VALIDITY_STAGES[5]])(
    'restores on failure at %s without passing skipped stages', async (failure) => {
      const f = await fixture()
      f.setFailure(failure)
      await expect(runSchemaValidityChecks(f.input)).rejects.toThrow('Schema validity checks or fixture restoration failed')
      f.assertRestored()
      expect(f.input.complete).not.toHaveBeenCalledWith(SCHEMA_VALIDITY_STAGES[6])
      const stages = vi.mocked(f.input.complete).mock.calls.flat()
      expect(stages).toEqual(SCHEMA_VALIDITY_STAGES.slice(0, stages.length))
      if (failure === 'transfer') expect(stages).toEqual([SCHEMA_VALIDITY_STAGES[0]])
      if (failure === 'reject') expect(stages).not.toContain(SCHEMA_VALIDITY_STAGES[3])
    })
  it('propagates SAS zero-creation failure rather than treating an untested bind as a pass', async () => {
    const f = await fixture()
    const send = f.input.send
    f.input.send = async (payer, instructions) => {
      if (instructions[0]?.programAddress === SAS_PROGRAM_ID && instructions[0]?.data?.[0] === 6) {
        throw new Error('SAS rejected zero-expiry creation')
      }
      return send(payer, instructions)
    }
    await expect(runSchemaValidityChecks(f.input)).rejects.toThrow()
    expect(vi.mocked(f.input.complete).mock.calls.flat()).toEqual(SCHEMA_VALIDITY_STAGES.slice(0, 3))
    expect(f.input.reject).not.toHaveBeenCalled()
    f.assertRestored()
  })
  it('rejects nonlocal input before reads or submissions', async () => {
    const f = await fixture()
    f.input.ctx.rpcUrl = 'https://api.devnet.solana.com'
    await expect(runSchemaValidityChecks(f.input)).rejects.toThrow('localnet')
    expect(readAccounts).not.toHaveBeenCalled()
    expect(f.input.send).not.toHaveBeenCalled()
  })
  it('attempts the second binding restore after the first fails and retains referenced temporary proofs', async () => {
    const f = await fixture()
    const send = f.input.send
    f.input.send = async (payer, instructions) => {
      const ix = instructions[0]!
      if (ix.programAddress === f.input.ctx.programId && ix.accounts?.[6]?.address === addr(20)) {
        throw new Error('Injected first binding cleanup failure')
      }
      return send(payer, instructions)
    }
    await expect(runSchemaValidityChecks(f.input)).rejects.toThrow('fixture restoration failed')
    expect(f.accounts.get(f.bindingAddresses[1]!)).toEqual(f.initial.get(f.bindingAddresses[1]!))
    expect(f.accounts.get(addr(6))).toEqual(f.initial.get(addr(6)))
    expect(f.proofs.size).toBe(2)
    expect(f.sent).not.toContain(7)
    expect(f.input.complete).not.toHaveBeenCalledWith(SCHEMA_VALIDITY_STAGES[6])
  })
  it('never passes an expired case when the RPC Clock does not advance; polling is bounded and fixtures restore', async () => {
    const f = await fixture()
    f.freezeClock()
    vi.useFakeTimers()
    try {
      const result = expect(runSchemaValidityChecks(f.input)).rejects.toThrow('fixture restoration failed')
      await vi.waitFor(() => expect(f.input.complete).toHaveBeenCalledWith(SCHEMA_VALIDITY_STAGES[4]))
      await vi.runAllTimersAsync()
      await result
      expect(f.input.complete).not.toHaveBeenCalledWith(SCHEMA_VALIDITY_STAGES[5])
      f.assertRestored()
    } finally { vi.useRealTimers() }
  })
})
