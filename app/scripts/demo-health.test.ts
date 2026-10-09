import { getTokenEncoder } from '@solana-program/token-2022'
import { getAddressDecoder } from '@solana/kit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readAccounts, type RawAccount } from '../src/api/accounts'
import { inspectEligibility } from '../src/api/eligibility'
import { AVEO_HOOK_PROGRAM_ID, SAS_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '../src/api/constants'
import type { ApiContext } from '../src/api/context'
import type { DeskSnapshot } from '../src/api/diagnostics'
import type { Deployment } from '../src/config/deployment'
import { checkDemoHealth, decodeHealthyToken, healthSubjects, HEALTH_STAGES, requireHealthySnapshot } from './demo-health'

vi.mock('../src/api/accounts', () => ({ readAccounts: vi.fn() }))
vi.mock('../src/api/eligibility', () => ({ inspectEligibility: vi.fn() }))
const addr = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n))
const deployment: Deployment = {
  version: 1, cluster: 'localnet', generatedAt: '2026-10-09T12:00:00.000Z',
  programs: { aveoHook: AVEO_HOOK_PROGRAM_ID, sas: SAS_PROGRAM_ID, token2022: TOKEN_2022_PROGRAM_ID },
  proofDomain: 'a'.repeat(64), issuer: addr(1), verifiers: [],
  assets: [{ id: 'alfa', mint: addr(2), decimals: 0, label: 'Alfa', symbol: 'ALFA' },
    { id: 'beta', mint: addr(3), decimals: 0, label: 'Beta', symbol: 'BETA' }],
  wallets: [{ id: 'treasury', address: addr(4), label: 'Treasury', role: 'treasury' },
    { id: 'X', address: addr(5), label: 'X', role: 'investor' }],
}
const ctx = { cluster: 'localnet', rpcUrl: 'http://127.0.0.1:8899', commitment: 'confirmed', programId: AVEO_HOOK_PROGRAM_ID, deployment } as ApiContext
function snapshot(mint = addr(2), wallet = addr(4)): DeskSnapshot {
  return { backend: 'aveo-sas-hook', mint, wallet, verdict: 'eligible', policyVersion: 1n, clockUnix: 100,
    read: { cluster: 'localnet', rpcUrl: ctx.rpcUrl, commitment: 'confirmed', slot: 42, observedAt: deployment.generatedAt },
    reasons: [], actions: [], sourceAccounts: { attestation: addr(6) },
    proof: { attestation: addr(6), credential: addr(7), schema: addr(8), signer: addr(9), expiry: 220n, kycPass: true, accreditedPass: true },
  } as DeskSnapshot
}
function token(mint = addr(2), owner = addr(4), patch = {}): RawAccount {
  return { address: addr(10), owner: TOKEN_2022_PROGRAM_ID, executable: false, lamports: 1n,
    data: new Uint8Array(getTokenEncoder().encode({ mint, owner, amount: 10n, delegate: null, state: 1,
      isNative: null, delegatedAmount: 0n, closeAuthority: null, extensions: [], ...patch })),
  }
}
beforeEach(() => vi.clearAllMocks())

describe('read-only demo readiness', () => {
  it('accepts a supported unambiguous local fixture manifest', () => {
    expect(healthSubjects(deployment).assets).toHaveLength(2)
  })
  it.each([
    { cluster: 'devnet' }, { generatedAt: 'invalid' }, { programs: { ...deployment.programs, aveoHook: addr(20) } },
    { assets: [deployment.assets[0]!, deployment.assets[0]!] },
    { assets: [deployment.assets[0]!, { ...deployment.assets[1]!, mint: addr(2) }] },
    { wallets: [deployment.wallets[0]!, deployment.wallets[0]!] },
    { wallets: [deployment.wallets[0]!, { ...deployment.wallets[1]!, address: addr(4) }] },
  ])('rejects ambiguous or mismatched fixtures %j', (patch) => {
    expect(() => healthSubjects({ ...deployment, ...patch } as Deployment)).toThrow()
  })
  it('accepts exactly two minutes of remaining lifetime against the chain clock', () => {
    expect(() => requireHealthySnapshot(ctx, snapshot(), addr(2), addr(4), 42)).not.toThrow()
    expect(() => requireHealthySnapshot(ctx, { ...snapshot(), proof: { ...snapshot().proof!, expiry: 219n } }, addr(2), addr(4), 42)).toThrow('two minutes')
  })
  it.each([
    { verdict: 'unknown' }, { verdict: 'ineligible' }, { mint: addr(12) }, { wallet: addr(12) },
    { backend: 'mpl3643' }, { clockUnix: undefined }, { proof: undefined },
    { read: { ...snapshot().read, slot: 41 } }, { read: { ...snapshot().read, slot: 42.5 } },
    { read: { ...snapshot().read, rpcUrl: 'https://different.invalid' } },
    { sourceAccounts: { attestation: addr(12) } },
  ])('never treats unknown, stale or unrelated evidence as ready %j', (patch) => {
    expect(() => requireHealthySnapshot(ctx, { ...snapshot(), ...patch } as DeskSnapshot, addr(2), addr(4), 42)).toThrow()
  })
  it('validates binary token data, program ownership, initialization and positive balance', () => {
    expect(decodeHealthyToken(token(), addr(2), addr(4)).amount).toBe(10n)
    for (const account of [null, { ...token(), owner: addr(20) }, { ...token(), executable: true },
      token(addr(20)), token(addr(2), addr(20)), token(addr(2), addr(4), { state: 2 }), token(addr(2), addr(4), { amount: 0n })]) {
      expect(() => decodeHealthyToken(account, addr(2), addr(4))).toThrow()
    }
  })
  async function healthy() {
    vi.mocked(inspectEligibility).mockImplementation(async (_ctx, mint, wallet) => snapshot(mint, wallet))
    vi.mocked(readAccounts).mockImplementation(async (_ctx, addresses, floor) => {
      if (floor === undefined) return { slot: 40, accounts: addresses.map((address) => ({ ...token(), address, executable: true })) }
      return { slot: 43, accounts: [token(addr(2), addr(4)), token(addr(2), addr(5)), token(addr(3), addr(4)), token(addr(3), addr(5))] }
    })
    const emit = vi.fn(), complete = vi.fn()
    await checkDemoHealth(ctx, emit, complete)
    return { emit, complete }
  }
  it('requires all six stages and a final token read at the latest eligibility floor', async () => {
    const { complete, emit } = await healthy()
    expect(complete.mock.calls.map(([stage]) => stage)).toEqual(HEALTH_STAGES)
    expect(vi.mocked(readAccounts).mock.calls[1]?.[2]).toBe(42)
    expect(emit).toHaveBeenCalledWith({ slot: 43, delegatedAllowanceAfter: '0' })
  })
  it('fails before any RPC activity on a public endpoint', async () => {
    await expect(checkDemoHealth({ ...ctx, rpcUrl: 'https://api.devnet.solana.com' }, vi.fn(), vi.fn())).rejects.toThrow('loopback')
    expect(readAccounts).not.toHaveBeenCalled()
    expect(inspectEligibility).not.toHaveBeenCalled()
  })
  it.each(['unknown', 'ineligible'] as const)('stops readiness on %s eligibility without checking token balances', async (verdict) => {
    vi.mocked(readAccounts).mockResolvedValue({ slot: 40, accounts: [token(), token(), token()].map((account) => ({ ...account, executable: true })) })
    vi.mocked(inspectEligibility).mockImplementation(async (_ctx, mint, wallet) => ({ ...snapshot(mint, wallet), verdict }))
    const complete = vi.fn()
    await expect(checkDemoHealth(ctx, vi.fn(), complete)).rejects.toThrow('blocked, unknown')
    expect(complete.mock.calls.map(([stage]) => stage)).toEqual(HEALTH_STAGES.slice(0, 2))
    expect(readAccounts).toHaveBeenCalledOnce()
  })
  it('cannot report the final readiness stage while a delegate remains', async () => {
    await healthy()
    const complete = vi.fn()
    vi.mocked(readAccounts).mockResolvedValueOnce({ slot: 40, accounts: [token(), token(), token()].map((account) => ({ ...account, executable: true })) })
      .mockResolvedValueOnce({ slot: 43, accounts: [token(addr(2), addr(4), { delegate: addr(15), delegatedAmount: 1n }),
        token(addr(2), addr(5)), token(addr(3), addr(4)), token(addr(3), addr(5))] })
    await expect(checkDemoHealth(ctx, vi.fn(), complete)).rejects.toThrow('delegate')
    expect(complete.mock.calls.map(([stage]) => stage)).not.toContain('health-no-delegate')
  })
})
