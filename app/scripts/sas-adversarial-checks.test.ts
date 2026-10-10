import { describe, expect, it, vi } from 'vitest'
import { generateKeyPairSigner, getAddressDecoder, getAddressEncoder, type Address, type Instruction, type Signature } from '@solana/kit'
import {
  getAttestationEncoder, getCredentialEncoder, getSchemaEncoder,
  getChangeAuthorizedSignersInstructionDataDecoder, getCreateAttestationInstructionDataDecoder,
} from 'sas-lib'
import type { RawAccount } from '../src/api/accounts'
import { decodeSasAttestation, decodeSasCredential, encodeEligibilityPayload } from '../src/api/codecs'
import { ACCOUNT_DISCRIMINATOR, AVEO_ELIGIBILITY_V2_LAYOUT, AVEO_HOOK_PROGRAM_ID, SAS_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '../src/api/constants'
import type { AdversarialContext } from './adversarial-context'
import {
  expectSasAccountUnchanged, expectSasSignerSet, malformedSasEligibilityPayloads, requireSasLedgerFailure,
  runSasAdversarialChecksWithDependencies, sasAdversarialDependencies, SAS_ADVERSARIAL_COVERAGE_GAPS, SAS_ADVERSARIAL_STAGES,
} from './sas-adversarial-checks'

const addr = (byte: number) => getAddressDecoder().decode(new Uint8Array(32).fill(byte))
const encodeAddress = (address: Address) => getAddressEncoder().encode(address)
const signature = 'test-signature' as Signature // DI never submits or validates a wire transaction.

async function fixture() {
  const [x, treasury, verifier, issuer] = await Promise.all(Array.from({ length: 4 }, () => generateKeyPairSigner()))
  const assets = [
    { id: 'alfa', label: 'Alfa', symbol: 'ALFA', mint: addr(10), decimals: 0 },
    { id: 'beta', label: 'Beta', symbol: 'BETA', mint: addr(11), decimals: 0 },
  ]
  const credential = addr(12), schema = addr(13)
  const proofAddresses = [addr(14), addr(15)]
  const accounts = new Map<Address, RawAccount>()
  const put = (address: Address, owner: Address, data: ArrayLike<number>) => {
    accounts.set(address, { address, owner, lamports: 1_000_000n, executable: false, data: new Uint8Array(data) })
  }
  // Multiple original signers verify that restoration preserves the complete ordered list.
  const originalSigners = [issuer.address, verifier.address]
  const credentialData = (signers: Address[]) => getCredentialEncoder().encode({ discriminator: 0,
    authority: verifier.address, name: new Uint8Array([65]), authorizedSigners: signers })
  put(credential, SAS_PROGRAM_ID, credentialData(originalSigners))
  put(schema, SAS_PROGRAM_ID, getSchemaEncoder().encode({ discriminator: 1, credential,
    name: new Uint8Array([66]), description: new Uint8Array(), fieldNames: new Uint8Array(),
    layout: new Uint8Array(AVEO_ELIGIBILITY_V2_LAYOUT), isPaused: false, version: 1 }))
  const payloads = [x, treasury].map((subject) => encodeEligibilityPayload({ subjectWallet: subject.address,
    proofDomain: new Uint8Array(32).fill(42), kycPass: true, accreditedPass: true }))
  proofAddresses.forEach((address, index) => put(address, SAS_PROGRAM_ID, getAttestationEncoder().encode({
    discriminator: 2, credential, schema, nonce: addr(index + 20), data: payloads[index]!,
    signer: verifier.address, expiry: 2_000_000_000n, tokenAccount: addr(0),
  })))
  const bindingAddresses: Address[] = []
  for (const asset of assets) {
    put(asset.mint, TOKEN_2022_PROGRAM_ID, [1])
    put(await sasAdversarialDependencies.findPolicyPda(AVEO_HOOK_PROGRAM_ID, asset.mint), AVEO_HOOK_PROGRAM_ID, [2])
    put(await sasAdversarialDependencies.findExtraAccountMetasPda(AVEO_HOOK_PROGRAM_ID, asset.mint), AVEO_HOOK_PROGRAM_ID, [3])
    for (const [index, subject] of [x, treasury].entries()) {
      const binding = await sasAdversarialDependencies.findBindingPda(AVEO_HOOK_PROGRAM_ID, asset.mint, subject.address)
      bindingAddresses.push(binding)
      put(binding, AVEO_HOOK_PROGRAM_ID, [
        ...ACCOUNT_DISCRIMINATOR.eligibilityBinding, 2, ...encodeAddress(asset.mint), ...encodeAddress(subject.address),
        ...encodeAddress(credential), ...encodeAddress(schema), ...encodeAddress(proofAddresses[index]!), 255,
      ])
      const [token] = await sasAdversarialDependencies.findAssociatedTokenPda({ owner: subject.address,
        mint: asset.mint, tokenProgram: TOKEN_2022_PROGRAM_ID })
      const data = new Uint8Array(165)
      data.set(encodeAddress(asset.mint), 0)
      data.set(encodeAddress(subject.address), 32)
      new DataView(data.buffer).setBigUint64(64, 10n, true)
      data[108] = 1
      put(token, TOKEN_2022_PROGRAM_ID, data)
    }
  }
  const initial = new Map([...accounts].map(([key, raw]) => [key, { ...raw, data: raw.data.slice() }]))
  let slot = 100
  const readAccounts = vi.fn(async (_ctx: unknown, addresses: Address[], floor?: number) => {
    slot = Math.max(slot + 1, floor ?? 0)
    return { slot, accounts: addresses.map((address) => {
      const raw = accounts.get(address)
      return raw ? { ...raw, data: raw.data.slice() } : null
    }) }
  })
  const send = vi.fn(async (_payer: unknown, instructions: Instruction[]): Promise<Signature> => {
    for (const instruction of instructions) {
      expect(instruction.programAddress).toBe(SAS_PROGRAM_ID)
      if (instruction.data![0] === 3) {
        const { signers } = getChangeAuthorizedSignersInstructionDataDecoder().decode(instruction.data!)
        put(credential, SAS_PROGRAM_ID, credentialData(signers))
      } else {
        expect(instruction.data![0]).toBe(6)
        const args = getCreateAttestationInstructionDataDecoder().decode(instruction.data!)
        // The live SAS program refuses a truncated payload at issuance.
        expect(args.data).toHaveLength(75)
        const metas = instruction.accounts!
        expect(metas[2]!.address).toBe(credential)
        expect(metas[3]!.address).toBe(schema)
        const actualSigners = decodeSasCredential(accounts.get(credential)!.data).authorizedSigners
        expect(actualSigners).toContain(metas[1]!.address)
        put(metas[4]!.address, SAS_PROGRAM_ID, getAttestationEncoder().encode({ ...args, discriminator: 2,
          credential, schema, signer: metas[1]!.address, tokenAccount: addr(0) }))
      }
    }
    return signature
  })
  const reject = vi.fn(async (_payer: unknown, _instructions: Instruction[], _code: string): Promise<unknown> =>
    ({ status: 'failed', slot: ++slot, logs: [`Program ${AVEO_HOOK_PROGRAM_ID} failed: test ledger observation`] }))
  const transfer = vi.fn(async () => {})
  let nonce = 30
  const input = {
    ctx: { cluster: 'localnet', commitment: 'confirmed', programId: AVEO_HOOK_PROGRAM_ID, rpc: {} },
    deployment: {}, assets, x, treasury, verifier, issuer, nonce: async () => addr(nonce++),
    send, reject, transfer, emit: vi.fn(), complete: vi.fn(),
  } as unknown as AdversarialContext
  const deps = { ...sasAdversarialDependencies, readAccounts }
  return { input, deps, accounts, initial, credential, schema, originalSigners, bindingAddresses, payloads,
    send, reject, transfer, readAccounts }
}

describe('bounded SAS adversarial acceptance', () => {
  it('builds opaque malformed payloads without changing the original bytes', () => {
    const payload = new Uint8Array(75).fill(1)
    const [boolean] = malformedSasEligibilityPayloads(payload)
    expect(malformedSasEligibilityPayloads(payload)).toHaveLength(1)
    expect(boolean![73]).toBe(2)
    expect(boolean!.filter((_byte, index) => index !== 73)).toEqual(payload.filter((_byte, index) => index !== 73))
    expect(payload[73]).toBe(1)
    expect(() => malformedSasEligibilityPayloads(new Uint8Array(74))).toThrow('75-byte')
  })

  it('checks every protected field and ordered signers, rejecting absence and byte corruption', () => {
    const raw: RawAccount = { address: addr(1), owner: addr(2), lamports: 1n, executable: false, data: new Uint8Array([1, 2]) }
    expect(() => expectSasAccountUnchanged(raw, { ...raw, data: raw.data.slice() })).not.toThrow()
    for (const changed of [null, { ...raw, address: addr(3) }, { ...raw, owner: addr(3) }, { ...raw, lamports: 2n },
      { ...raw, executable: true }, { ...raw, data: new Uint8Array([1]) }, { ...raw, data: new Uint8Array([1, 3]) }]) {
      expect(() => expectSasAccountUnchanged(raw, changed)).toThrow()
    }
    expect(() => expectSasAccountUnchanged(null, raw)).toThrow()
    expect(() => expectSasSignerSet([addr(1), addr(2)], [addr(2), addr(1)])).toThrow()
    expect(() => expectSasSignerSet([addr(1)], [addr(1), addr(2)])).toThrow()
  })

  it.each([undefined, new Error('SDK rejected'), { ok: false }, { status: 'confirmed', slot: 1, logs: ['failure'] },
    { status: 'failed', logs: ['failure'] }, { status: 'failed', slot: -1, logs: ['failure'] },
    { status: 'failed', slot: NaN, logs: ['failure'] }, { status: 'failed', slot: 1, logs: [] },
    { status: 'failed', slot: 1, logs: [null] }])('rejects nonledger or unverifiable failure observations: %j', (result) => {
    expect(() => requireSasLedgerFailure(result)).toThrow()
  })

  it('runs four stages in order using real SDK builders, both directions and original signer restoration', async () => {
    const f = await fixture()
    await runSasAdversarialChecksWithDependencies(f.input, f.deps)
    expect(vi.mocked(f.input.complete).mock.calls.map(([stage]) => stage)).toEqual([...SAS_ADVERSARIAL_STAGES])
    expect(f.reject.mock.calls.map((call) => call[2])).toEqual([
      ...Array(2).fill('InvalidSasOwnerOrData'), ...Array(4).fill('UnauthorizedAttestationSigner'),
    ])
    expect(f.reject.mock.calls.every(([payer, instructions]) => payer === f.input.issuer
      && instructions[0]!.accounts![0]!.address === f.input.x.address)).toBe(true)
    const created = f.send.mock.calls.flatMap(([, instructions]) => instructions).filter((ix) => ix.data![0] === 6)
    expect(created.map((ix) => getCreateAttestationInstructionDataDecoder().decode(ix.data!).data.length)).toEqual([75, 75])
    expect(getCreateAttestationInstructionDataDecoder().decode(created[0]!.data!).data[73]).toBe(2)
    expect(created[1]!.accounts![1]!.address).toBe(f.input.x.address)
    const negative = vi.mocked(f.input.transfer).mock.calls.filter((call) => !call[2])
    expect(negative).toHaveLength(4)
    f.input.assets.forEach((asset, index) => {
      expect(negative[index * 2]).toEqual([asset, f.input.x.address, false, 'UnauthorizedAttestationSigner', f.input.treasury])
      expect(negative[index * 2 + 1]).toEqual([asset, f.input.treasury.address, false, 'UnauthorizedAttestationSigner', f.input.x])
    })
    for (const [address, raw] of f.initial) expectSasAccountUnchanged(raw, f.accounts.get(address)!)
    const signerEvidence = vi.mocked(f.input.emit).mock.calls.map(([data]) => data.authorizedSigners).filter(Boolean)
    expect(signerEvidence).toEqual([
      [f.input.issuer.address, f.input.x.address], f.originalSigners,
      [f.input.issuer.address, f.input.x.address], f.originalSigners,
    ])
    expect(f.readAccounts.mock.calls.every(([, addresses]) => !addresses.includes(f.input.issuer.address))).toBe(true)
    const auxiliary = [...f.accounts.keys()].filter((address) => !f.initial.has(address))
    expect(auxiliary).toHaveLength(2)
    expect(decodeSasAttestation(f.accounts.get(auxiliary[1]!)!.data).signer).toBe(f.input.x.address)
    expect(SAS_ADVERSARIAL_COVERAGE_GAPS.join(' ')).toContain('T10 remains NOT_RUN')
  })

  it.each(['transfer', 'reporting', 'ambiguous-send', 'complete'])('restores original signers after %s failure and never completes restoration stage', async (failure) => {
    const f = await fixture()
    const error = new Error(`Injected ${failure} failure`)
    if (failure === 'transfer') vi.mocked(f.input.transfer).mockImplementation(async (_asset, _destination, accepted) => { if (!accepted) throw error })
    if (failure === 'reporting') vi.mocked(f.input.emit).mockImplementation((evidence) => { if (evidence.authorizedSigners?.includes(f.input.x.address)) throw error })
    if (failure === 'complete') vi.mocked(f.input.complete).mockImplementation((stage) => { if (stage === SAS_ADVERSARIAL_STAGES[1]) throw error })
    if (failure === 'ambiguous-send') {
      const originalSend = f.send.getMockImplementation()!
      let failed = false
      f.send.mockImplementation(async (payer, instructions) => {
        const result = await originalSend(payer, instructions)
        if (!failed && instructions[0]!.data![0] === 3) { failed = true; throw error }
        return result
      })
    }
    let result: unknown
    try { await runSasAdversarialChecksWithDependencies(f.input, f.deps) } catch (caught) { result = caught }
    expect(result).toBeInstanceOf(AggregateError)
    expect((result as AggregateError).errors).toContain(error)
    expect(decodeSasCredential(f.accounts.get(f.credential)!.data).authorizedSigners).toEqual(f.originalSigners)
    for (const [address, raw] of f.initial) expectSasAccountUnchanged(raw, f.accounts.get(address)!)
    expect(f.input.complete).not.toHaveBeenCalledWith(SAS_ADVERSARIAL_STAGES[3])
    expect(f.readAccounts.mock.calls.at(-1)![1]).toContain(f.schema)
  })

  it('detects changed binding bytes after a ledger rejection instead of completing a stage', async () => {
    const f = await fixture()
    f.reject.mockImplementation(async () => {
      f.accounts.get(f.bindingAddresses[0]!)!.data[169] ^= 1
      return { status: 'failed', slot: 200, logs: ['ledger failure'] }
    })
    await expect(runSasAdversarialChecksWithDependencies(f.input, f.deps)).rejects.toThrow()
    expect(f.input.complete).not.toHaveBeenCalled()
  })

  it('reports restoration failure alongside the original failure', async () => {
    const f = await fixture()
    vi.mocked(f.input.emit).mockImplementation((evidence) => { if (evidence.authorizedSigners?.includes(f.input.x.address)) throw new Error('report failed') })
    const originalSend = f.send.getMockImplementation()!
    f.send.mockImplementation(async (payer, instructions) => {
      if (instructions[0]!.data![0] === 3) {
        const { signers } = getChangeAuthorizedSignersInstructionDataDecoder().decode(instructions[0]!.data!)
        if (signers.includes(f.input.verifier.address)) throw new Error('restore failed')
      }
      return originalSend(payer, instructions)
    })
    let result: unknown
    try { await runSasAdversarialChecksWithDependencies(f.input, f.deps) } catch (error) { result = error }
    expect(result).toBeInstanceOf(AggregateError)
    expect((result as AggregateError).errors.map((error: Error) => error.message)).toContain('restore failed')
    expect(f.input.complete).not.toHaveBeenCalledWith(SAS_ADVERSARIAL_STAGES[3])
  })

  it('rejects an unconfirmed parent observation without treating SDK/simulation as success', async () => {
    const f = await fixture()
    f.reject.mockResolvedValue({ ok: false, error: { code: 'InvalidSasOwnerOrData' } })
    await expect(runSasAdversarialChecksWithDependencies(f.input, f.deps)).rejects.toThrow()
    expect(f.input.complete).not.toHaveBeenCalled()
  })
})
