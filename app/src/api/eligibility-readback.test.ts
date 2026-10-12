import { extension, getMintEncoder } from '@solana-program/token-2022'
import { getAddressDecoder, getAddressEncoder, getI64Encoder, getU64Encoder, none, some, type Address } from '@solana/kit'
import { getAttestationEncoder, getCredentialEncoder, getSchemaEncoder } from 'sas-lib'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readAccounts, type RawAccount } from './accounts'
import { encodeEligibilityPayload } from './codecs'
import { ACCOUNT_DISCRIMINATOR, AVEO_ELIGIBILITY_V2_LAYOUT, AVEO_HOOK_PROGRAM_ID, SAS_PROGRAM_ID, SYSVAR_CLOCK_ID, TOKEN_2022_PROGRAM_ID } from './constants'
import type { ApiContext } from './context'
import { inspectEligibility } from './eligibility'
import { findBindingPda, findPolicyPda, findSasAttestationPda, findSasCredentialPda, findSasSchemaPda } from './pdas'

vi.mock('./accounts', () => ({ readAccounts: vi.fn() }))

const addr = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n))
const encodeAddress = (address: Address) => getAddressEncoder().encode(address)
const account = (address: Address, owner: Address, data: Uint8Array): RawAccount => ({ address, owner, data, lamports: 1n, executable: false })
const domain = new Uint8Array(32).fill(8)

async function fixture() {
  const mint = addr(1), wallet = addr(2), authority = addr(3), nonce = addr(4)
  const name = new TextEncoder().encode('readback-verifier')
  const schemaName = new TextEncoder().encode('aveo-eligibility-v2')
  const credential = await findSasCredentialPda(authority, name)
  const schema = await findSasSchemaPda(credential, schemaName, 1)
  const attestation = await findSasAttestationPda(credential, schema, nonce)
  const policyAddress = await findPolicyPda(AVEO_HOOK_PROGRAM_ID, mint)
  const bindingAddress = await findBindingPda(AVEO_HOOK_PROGRAM_ID, mint, wallet)
  const policy = (options: { active?: boolean; removeProvider?: boolean; requireAccredited?: boolean; version?: bigint } = {}) => account(policyAddress, AVEO_HOOK_PROGRAM_ID, new Uint8Array([
    ...ACCOUNT_DISCRIMINATOR.issuerPolicy, 2, ...encodeAddress(mint), ...encodeAddress(authority), ...encodeAddress(SAS_PROGRAM_ID), ...domain,
    1, ...encodeAddress(options.removeProvider ? addr(9) : credential), ...encodeAddress(schema), ...new Uint8Array(64),
    1, options.requireAccredited ? 1 : 0, options.active === false ? 0 : 1, ...getU64Encoder().encode(options.version ?? 2n), 255,
  ]))
  const binding = (proof = attestation) => account(bindingAddress, AVEO_HOOK_PROGRAM_ID, new Uint8Array([
    ...ACCOUNT_DISCRIMINATOR.eligibilityBinding, 2, ...encodeAddress(mint), ...encodeAddress(wallet), ...encodeAddress(credential), ...encodeAddress(schema), ...encodeAddress(proof), 255,
  ]))
  const clock = (unix: bigint) => account(SYSVAR_CLOCK_ID, addr(8), new Uint8Array([
    ...getU64Encoder().encode(0n), ...getI64Encoder().encode(0n), ...getU64Encoder().encode(0n), ...getU64Encoder().encode(0n), ...getI64Encoder().encode(unix),
  ]))
  const mintAccount = account(mint, TOKEN_2022_PROGRAM_ID, new Uint8Array(getMintEncoder().encode({ mintAuthority: none(), supply: 1000n, decimals: 0, isInitialized: true, freezeAuthority: none(), extensions: some([extension('TransferHook', { authority, programId: AVEO_HOOK_PROGRAM_ID })]) })))
  const sas = [
    account(credential, SAS_PROGRAM_ID, new Uint8Array(getCredentialEncoder().encode({ discriminator: 0, authority, name, authorizedSigners: [authority] }))),
    account(schema, SAS_PROGRAM_ID, new Uint8Array(getSchemaEncoder().encode({ discriminator: 1, credential, name: schemaName, description: new Uint8Array(), layout: new Uint8Array(AVEO_ELIGIBILITY_V2_LAYOUT), fieldNames: new Uint8Array(), isPaused: false, version: 1 }))),
    account(attestation, SAS_PROGRAM_ID, new Uint8Array(getAttestationEncoder().encode({ discriminator: 2, nonce, credential, schema, signer: authority, expiry: 101n, tokenAccount: addr(6), data: encodeEligibilityPayload({ subjectWallet: wallet, proofDomain: domain, kycPass: true, accreditedPass: false }) }))),
  ]
  const ctx = { programId: AVEO_HOOK_PROGRAM_ID, cluster: 'localnet', rpcUrl: 'http://localhost:8899', commitment: 'confirmed', deployment: { assets: [{ mint, label: 'Alfa' }], verifiers: [{ credential, label: 'A' }] } } as ApiContext
  const first = [policy(), mintAccount, binding(), clock(100n)]
  return { mint, wallet, ctx, first, sas, policy, binding, clock, mintAccount, credential, schema, attestation }
}

describe('coherent eligibility readback', () => {
  beforeEach(() => vi.clearAllMocks())

  async function inspect(change: (f: Awaited<ReturnType<typeof fixture>>) => (RawAccount | null)[]) {
    const f = await fixture()
    const latest = change(f)
    const keys = [...f.first, ...f.sas].map((a) => a.address)
    vi.mocked(readAccounts).mockResolvedValueOnce({ slot: 10, accounts: f.first }).mockImplementationOnce(async (_ctx, addresses) => ({ slot: 11, accounts: addresses.map((address) => latest[keys.indexOf(address)] ?? null) }))
    return { f, result: await inspectEligibility(f.ctx, f.mint, f.wallet) }
  }

  it('rereads all decision accounts together at or after discovery', async () => {
    const { f, result } = await inspect((f) => [...f.first, ...f.sas])
    expect(result).toMatchObject({ verdict: 'eligible', clockUnix: 100, read: { slot: 11 }, policyVersion: 2n })
    expect(vi.mocked(readAccounts).mock.calls[1]).toEqual([f.ctx, [...f.first.map((a) => a.address), f.credential, f.schema, f.attestation], 10])
  })

  it('uses the final clock when expiry is crossed between reads', async () => {
    const { result } = await inspect((f) => [f.policy(), f.mintAccount, f.binding(), f.clock(101n), ...f.sas])
    expect(result).toMatchObject({ verdict: 'ineligible', clockUnix: 101, read: { slot: 11 } })
    expect(result.reasons[0]?.code).toBe('AttestationExpired')
  })

  it('reports the final policy version alongside its decision', async () => {
    const { result } = await inspect((f) => [f.policy({ version: 3n }), f.mintAccount, f.binding(), f.clock(100n), ...f.sas])
    expect(result).toMatchObject({ verdict: 'eligible', policyVersion: 3n, read: { slot: 11 } })
  })

  it.each([
    ['inactive', { active: false }, 'PolicyMissingOrInactive'],
    ['provider removed', { removeProvider: true }, 'ProviderPairNotAllowed'],
    ['new required fact', { requireAccredited: true }, 'RequiredFactMissing'],
  ] as const)('uses the final policy after %s', async (_name, options, code) => {
    const { result } = await inspect((f) => [f.policy(options), f.mintAccount, f.binding(), f.clock(100n), ...f.sas])
    expect(result.verdict).toBe('ineligible')
    expect(result.reasons[0]?.code).toBe(code)
    expect(result.read.slot).toBe(11)
  })

  it('does not combine a replacement binding with the old proof', async () => {
    const { result } = await inspect((f) => [f.policy(), f.mintAccount, f.binding(addr(99)), f.clock(100n), ...f.sas])
    expect(result).toMatchObject({ verdict: 'unknown', actions: [] })
    expect(result.reasons[0]?.code).toBe('ReadUnverifiable')
  })

  it('validates the final mint rather than only the discovery mint', async () => {
    const { result } = await inspect((f) => [f.policy(), { ...f.mintAccount, owner: addr(99) }, f.binding(), f.clock(100n), ...f.sas])
    expect(result.verdict).toBe('ineligible')
    expect(result.reasons[0]?.code).toBe('MintMismatch')
  })

  it('rejects an unreadable final clock', async () => {
    const { result } = await inspect((f) => [f.policy(), f.mintAccount, f.binding(), null, ...f.sas])
    expect(result.verdict).toBe('unknown')
  })

  it.each([-1n, 9_007_199_254_740_992n])('rejects an invalid final clock timestamp (%s)', async (unix) => {
    const { result } = await inspect((f) => [f.policy(), f.mintAccount, f.binding(), f.clock(unix), ...f.sas])
    expect(result).toMatchObject({ verdict: 'unknown', actions: [] })
  })

  it('detects a binding closed after discovery', async () => {
    const { result } = await inspect((f) => [f.policy(), f.mintAccount, null, f.clock(100n), ...f.sas])
    expect(result.verdict).toBe('ineligible')
    expect(result.reasons[0]?.code).toBe('BindingMissing')
  })

  it('keeps the policy decision slot when a rejected provider proof is read for display', async () => {
    const f = await fixture()
    vi.mocked(readAccounts).mockResolvedValueOnce({ slot: 10, accounts: [f.policy({ removeProvider: true }), f.mintAccount, f.binding(), f.clock(100n)] })
      .mockResolvedValueOnce({ slot: 11, accounts: f.sas })
    const result = await inspectEligibility(f.ctx, f.mint, f.wallet)
    expect(result).toMatchObject({ verdict: 'ineligible', read: { slot: 10 }, clockUnix: 100 })
    expect(result.reasons[0]?.code).toBe('ProviderPairNotAllowed')
    expect(result.proof?.attestation).toBe(f.attestation)
  })
})
