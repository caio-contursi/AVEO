import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createNoopSigner, getAddressDecoder, type Address, type KeyPairSigner, type Signature } from '@solana/kit'
import {
  extension, getMintDecoder, getMintEncoder, getTokenDecoder, getTokenEncoder, getMintToCheckedInstruction, getSetAuthorityInstruction,
  getInitializeTransferHookInstruction,
} from '@solana-program/token-2022'
import { getCreateAttestationInstruction, getCreateCredentialInstruction, getCreateSchemaInstruction } from 'sas-lib'
import { readAccounts, type RawAccount } from '../src/api/accounts'
import { getInitPolicyInstruction, getSetBindingInstruction } from '../src/api/instructions'
import { buildInstructions, tokenAccountsFor } from '../src/api/transactions'
import { AVEO_DEVNET_HOOK_PROGRAM_ID, AVEO_HOOK_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '../src/api/constants'
import { parseDeployment } from '../src/config/deployment'
import { buildDevnetFixtures, parseDevnetFixtureArgs, runDevnetFixturesCli, type DevnetFixtureRuntime } from './devnet-fixtures'

vi.mock('./lib', () => { throw new Error('Local-only utilities must never be imported') })
vi.mock('../src/api/accounts', () => ({ readAccounts: vi.fn() }))
vi.mock('../src/api/transactions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/transactions')>()
  return { ...actual, buildInstructions: vi.fn(async () => [{ programAddress: AVEO_DEVNET_HOOK_PROGRAM_ID }]) }
})
vi.mock('sas-lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sas-lib')>()
  return { ...actual, getCreateAttestationInstruction: vi.fn(actual.getCreateAttestationInstruction),
    getCreateCredentialInstruction: vi.fn(actual.getCreateCredentialInstruction), getCreateSchemaInstruction: vi.fn(actual.getCreateSchemaInstruction) }
})
vi.mock('@solana-program/token-2022', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana-program/token-2022')>()
  return { ...actual, getMintToCheckedInstruction: vi.fn(actual.getMintToCheckedInstruction),
    getSetAuthorityInstruction: vi.fn(actual.getSetAuthorityInstruction), getInitializeTransferHookInstruction: vi.fn(actual.getInitializeTransferHookInstruction) }
})
vi.mock('../src/api/instructions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/instructions')>()
  return { ...actual, getInitPolicyInstruction: vi.fn(actual.getInitPolicyInstruction), getSetBindingInstruction: vi.fn(actual.getSetBindingInstruction) }
})

const addr = (id: number): Address => getAddressDecoder().decode(new Uint8Array(32).fill(id))
const signature = (id: number) => `mock-signature-${id}` as Signature
const cli = ['--execute-synthetic-devnet', '--directory', '/tmp/aveo-devnet-synthetic', '--rpc', 'https://api.devnet.solana.com', '--ws', 'wss://api.devnet.solana.com']

function mockRuntime() {
  const signers = new Map<string, KeyPairSigner>()
  const events: string[] = []
  const statusSend = vi.fn(async () => ({ value: Array.from({ length: 4 }, (_, i) => ({ slot: BigInt(101 + i), err: null, confirmationStatus: 'confirmed' })) }))
  const rentSend = vi.fn(async () => 2_000_000n)
  const runtime = {
    directory: '/tmp/aveo-devnet-synthetic', rpcUrl: cli[4], wsUrl: cli[6],
    rpc: { getMinimumBalanceForRentExemption: vi.fn(() => ({ send: rentSend })), getSignatureStatuses: vi.fn(() => ({ send: statusSend })) } as unknown as DevnetFixtureRuntime['rpc'],
    newWallet: vi.fn(async (id: string, label: string, role: Parameters<DevnetFixtureRuntime['newWallet']>[2]) => {
      events.push(`wallet:${id}`)
      // Public mock addresses only: no generation of cryptographic keys or signing capability.
      const signer = createNoopSigner(addr(signers.size + 1)) as unknown as KeyPairSigner
      signers.set(id, signer)
      return { signer, record: { id, label, role, secretKey: [99] } }
    }),
    fund: vi.fn(async () => { events.push('fund') }),
    send: vi.fn<DevnetFixtureRuntime['send']>(async () => { events.push('send'); return signature(events.length) }),
    writePublicDeployment: vi.fn(() => { events.push('publish') }),
  } satisfies DevnetFixtureRuntime
  const snapshot = async (): Promise<{ slot: number; accounts: RawAccount[] }> => {
    const accounts: RawAccount[] = []
    const raw = (address: Address, data: Uint8Array): RawAccount => ({ address, owner: TOKEN_2022_PROGRAM_ID, executable: false, lamports: 1n, data })
    const issuer = signers.get('issuer')!.address
    const holders = ['treasury', 'X', 'Y', 'Z'].map((id) => signers.get(id)!.address)
    for (const [i, id] of ['mint-alfa', 'mint-beta'].entries()) {
      const mint = signers.get(id)!.address
      accounts.push(raw(mint, new Uint8Array(getMintEncoder().encode({ mintAuthority: null, supply: 1000n, decimals: 0,
        isInitialized: true, freezeAuthority: null, extensions: [extension('TransferHook', { authority: issuer, programId: AVEO_DEVNET_HOOK_PROGRAM_ID })] }))))
      const atas = await tokenAccountsFor(mint, holders)
      for (const [j, owner] of holders.entries()) {
        accounts.push(raw(atas[j]!, new Uint8Array(getTokenEncoder().encode({ mint, owner,
          amount: (i === 0 ? [910n, 50n, 30n, 10n] : [980n, 20n, 0n, 0n])[j]!,
          delegate: null, state: 1, isNative: null, delegatedAmount: 0n, closeAuthority: null, extensions: null }))))
      }
    }
    return { slot: 104, accounts }
  }
  vi.mocked(readAccounts).mockImplementation(snapshot)
  return { runtime, signers, events, snapshot, statusSend, rentSend }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(buildInstructions).mockReset().mockResolvedValue([{ programAddress: AVEO_DEVNET_HOOK_PROGRAM_ID }])
  vi.mocked(readAccounts).mockReset()
})
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('synthetic devnet fixture generator', () => {
  it('creates real instruction payloads for the approved scenario with mock signers and no network', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
    const { runtime, signers, events } = mockRuntime()
    const deployment = await buildDevnetFixtures(runtime)
    expect(parseDeployment(deployment).cluster).toBe('devnet')
    expect(deployment.programs.aveoHook).toBe('28DDiRDHkqaYYYaZvoFDDpwxUfuZcaehjJpiZfKwzuKS')
    expect(deployment.programs.aveoHook).toBe(AVEO_DEVNET_HOOK_PROGRAM_ID)
    expect(JSON.stringify(deployment)).not.toContain(AVEO_HOOK_PROGRAM_ID)
    expect(deployment.proofDomain).toBe(createHash('sha256').update('aveo-demo-devnet').digest('hex'))
    expect(deployment.proofDomain).not.toBe(createHash('sha256').update('aveo-demo-localnet').digest('hex'))
    expect(runtime.newWallet.mock.calls.map(([id]) => id)).toEqual([
      'issuer', 'verifier-a', 'verifier-b', 'treasury', 'X', 'Y', 'Z', 'nonce-1', 'nonce-2', 'nonce-3', 'nonce-4', 'mint-alfa', 'mint-beta',
    ])
    expect(runtime.fund.mock.calls).toEqual(['issuer', 'verifier-a', 'verifier-b', 'treasury', 'X', 'Y', 'Z'].map((id, i) => [signers.get(id)!.address, i === 0 ? 1_000_000_000n : 50_000_000n]))
    expect(getCreateCredentialInstruction).toHaveBeenCalledTimes(2)
    expect(getCreateSchemaInstruction).toHaveBeenCalledTimes(2)
    const attestations = vi.mocked(getCreateAttestationInstruction).mock.calls.map(([args]) => args)
    expect(attestations.map((args) => Number(args.expiry))).toEqual([1_800_000_000 + 30 * 86400, 1_800_001_200, 1_800_000_000 + 30 * 86400, 1_800_000_000 + 30 * 86400])
    expect(attestations.map((args) => args.nonce)).toEqual([1, 2, 3, 4].map((i) => signers.get(`nonce-${i}`)!.address))
    const policies = vi.mocked(getInitPolicyInstruction).mock.calls.map(([args]) => args.args)
    expect(policies.map((args) => [args.pairs.length, args.requireKyc, args.requireAccredited, args.active])).toEqual([[2, true, false, true], [1, true, true, true]])
    expect(getInitializeTransferHookInstruction).toHaveBeenCalledTimes(2)
    expect(vi.mocked(getInitializeTransferHookInstruction).mock.calls.every(([args]) => args.programId === AVEO_DEVNET_HOOK_PROGRAM_ID)).toBe(true)
    expect(vi.mocked(getInitPolicyInstruction).mock.calls.every(([args]) => args.programId === AVEO_DEVNET_HOOK_PROGRAM_ID)).toBe(true)
    expect(vi.mocked(getMintToCheckedInstruction).mock.calls.map(([args]) => args.amount)).toEqual([1000n, 1000n])
    expect(vi.mocked(getSetAuthorityInstruction).mock.calls.every(([args]) => args.newAuthority === null)).toBe(true)
    expect(getSetBindingInstruction).toHaveBeenCalledTimes(8)
    expect(vi.mocked(getSetBindingInstruction).mock.calls.every(([args]) => args.programId === AVEO_DEVNET_HOOK_PROGRAM_ID)).toBe(true)
    expect(vi.mocked(buildInstructions).mock.calls.map(([, request]) => 'amount' in request ? request.amount : undefined)).toEqual([50n, 20n, 30n, 10n])
    for (const [ctx, , signer] of vi.mocked(buildInstructions).mock.calls) {
      expect(ctx.rpc).toBe(runtime.rpc)
      expect(ctx.cluster).toBe('devnet')
      expect(ctx.programId).toBe(AVEO_DEVNET_HOOK_PROGRAM_ID)
      expect(signer).toBe(signers.get('treasury'))
    }
    expect(runtime.send).toHaveBeenCalledTimes(26)
    expect(runtime.send.mock.calls.flatMap(([, instructions]) => instructions).every((instruction) =>
      instruction.programAddress !== AVEO_HOOK_PROGRAM_ID && (instruction.accounts ?? []).every((account) => account.address !== AVEO_HOOK_PROGRAM_ID),
    )).toBe(true)
    expect(runtime.send.mock.calls.slice(-4).every((call) => (call as unknown[])[2] === 1_000_000)).toBe(true)
    expect(readAccounts).toHaveBeenCalledWith(expect.objectContaining({ rpc: runtime.rpc }), expect.any(Array), 104)
    expect(runtime.writePublicDeployment).toHaveBeenCalledExactlyOnceWith(deployment)
    expect(events.at(-1)).toBe('publish')
    expect(JSON.stringify(deployment)).not.toMatch(/secretKey|nonce-|missing-binding|signer/)
  })

  it('uses an explicit TTL only for X', async () => {
    const { runtime } = mockRuntime()
    const before = Math.floor(Date.now() / 1000)
    await buildDevnetFixtures(runtime, 2400)
    expect(Number(vi.mocked(getCreateAttestationInstruction).mock.calls[1][0].expiry)).toBeGreaterThanOrEqual(before + 2400)
  })

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])('rejects invalid TTL %s before any runtime call', async (ttl) => {
    const { runtime } = mockRuntime()
    await expect(buildDevnetFixtures(runtime, ttl)).rejects.toThrow('TTL')
    expect(runtime.newWallet).not.toHaveBeenCalled()
    expect(runtime.fund).not.toHaveBeenCalled()
    expect(runtime.send).not.toHaveBeenCalled()
  })

  it.each(['wallet', 'fund', 'rent', 'send', 'transfer', 'read'])('stops immediately on %s failure without publishing or retrying', async (stage) => {
    const { runtime, rentSend } = mockRuntime()
    const error = new Error('Unknown outcome; stop')
    if (stage === 'wallet') runtime.newWallet.mockRejectedValueOnce(error)
    if (stage === 'fund') runtime.fund.mockRejectedValueOnce(error)
    if (stage === 'rent') rentSend.mockRejectedValueOnce(error)
    if (stage === 'send') runtime.send.mockRejectedValueOnce(error)
    if (stage === 'transfer') vi.mocked(buildInstructions).mockRejectedValueOnce(error)
    if (stage === 'read') vi.mocked(readAccounts).mockRejectedValueOnce(error)
    await expect(buildDevnetFixtures(runtime)).rejects.toBe(error)
    expect(runtime.writePublicDeployment).not.toHaveBeenCalled()
    if (stage === 'wallet') expect(runtime.newWallet).toHaveBeenCalledTimes(1)
    if (stage === 'fund') expect(runtime.fund).toHaveBeenCalledTimes(1)
    if (stage === 'send') expect(runtime.send).toHaveBeenCalledTimes(1)
    if (stage === 'transfer') expect(runtime.send).toHaveBeenCalledTimes(22)
  })

  it.each(Array.from({ length: 26 }, (_, index) => index + 1))('never sends another transaction after unknown outcome at send %i', async (failedCall) => {
    const { runtime } = mockRuntime()
    const error = new Error('Unknown transaction outcome')
    let calls = 0
    runtime.send.mockImplementation(async () => {
      if (++calls === failedCall) throw error
      return signature(calls)
    })
    await expect(buildDevnetFixtures(runtime)).rejects.toBe(error)
    expect(runtime.send).toHaveBeenCalledTimes(failedCall)
    expect(runtime.writePublicDeployment).not.toHaveBeenCalled()
  })

  it.each(['missing', 'stale', 'supply', 'authority', 'balance', 'owner', 'executable', 'hook', 'local-hook'])('withholds the manifest on invalid final accounting: %s', async (kind) => {
    const { runtime, snapshot } = mockRuntime()
    vi.mocked(readAccounts).mockImplementationOnce(async () => {
      const result = await snapshot()
      if (kind === 'stale') result.slot = 103
      if (kind === 'missing') result.accounts.pop()
      if (kind === 'owner') result.accounts[1].owner = AVEO_DEVNET_HOOK_PROGRAM_ID
      if (kind === 'executable') result.accounts[0].executable = true
      if (['supply', 'authority', 'hook', 'local-hook'].includes(kind)) {
        const mint = getMintDecoder().decode(result.accounts[0].data)
        result.accounts[0].data = new Uint8Array(getMintEncoder().encode({ ...mint,
          mintAuthority: kind === 'authority' ? addr(1) : null, supply: kind === 'supply' ? 1001n : 1000n,
          extensions: kind === 'hook' ? null : kind === 'local-hook'
            ? [extension('TransferHook', { authority: addr(1), programId: AVEO_HOOK_PROGRAM_ID })] : mint.extensions,
        }))
      }
      if (kind === 'balance') result.accounts[1].data = new Uint8Array(getTokenEncoder().encode({
        ...getTokenDecoder().decode(result.accounts[1].data), amount: 909n,
      }))
      return result
    })
    await expect(buildDevnetFixtures(runtime)).rejects.toThrow()
    expect(runtime.writePublicDeployment).not.toHaveBeenCalled()
  })

  it('rejects unconfirmed ledger status before the final read', async () => {
    const { runtime, statusSend } = mockRuntime()
    statusSend.mockResolvedValueOnce({ value: [] })
    await expect(buildDevnetFixtures(runtime)).rejects.toThrow('ledger statuses')
    expect(readAccounts).not.toHaveBeenCalled()
    expect(runtime.writePublicDeployment).not.toHaveBeenCalled()
  })

  it.each(['failed', 'processed', 'null', 'slot'])('rejects %s transfer evidence before accounting', async (kind) => {
    const { runtime, statusSend } = mockRuntime()
    const value = Array.from({ length: 4 }, () => ({ slot: kind === 'slot' ? -1n : 104n,
      err: kind === 'failed' ? { InstructionError: [0, 'failure'] } : null,
      confirmationStatus: kind === 'processed' ? 'processed' : 'confirmed',
    }))
    statusSend.mockResolvedValueOnce({ value: kind === 'null' ? [null, ...value.slice(1)] : value } as unknown as Awaited<ReturnType<typeof statusSend>>)
    await expect(buildDevnetFixtures(runtime)).rejects.toThrow('ledger statuses')
    expect(readAccounts).not.toHaveBeenCalled()
    expect(runtime.writePublicDeployment).not.toHaveBeenCalled()
  })
})

describe('devnet fixture CLI', () => {
  it('requires all explicit flags and forwards the approved runtime contract', async () => {
    const { runtime } = mockRuntime()
    const factory = vi.fn(async () => runtime)
    await runDevnetFixturesCli([...cli, '--x-ttl', '2400'], factory)
    expect(factory).toHaveBeenCalledExactlyOnceWith({ directory: cli[2], rpcUrl: cli[4], wsUrl: cli[6] })
    expect(parseDevnetFixtureArgs(cli).ttl).toBe(1200)
  })

  it.each([
    [], cli.slice(1), cli.slice(0, -2), [...cli, '--unknown', 'yes'], [...cli, '--execute-synthetic-devnet'],
    [...cli, '--rpc', cli[4]], [...cli, '--x-ttl', '1.5'], [...cli, '--x-ttl', '0'], [...cli, '--x-ttl', '-1'],
    [...cli, '--x-ttl'], [...cli, 'extra'], cli.map((arg) => arg === cli[2] ? 'relative/directory' : arg),
    cli.map((arg) => arg === cli[4] ? 'file:///devnet' : arg), cli.map((arg) => arg === cli[6] ? 'https://api.devnet.solana.com' : arg),
    cli.map((arg) => arg === cli[4] ? 'https://user:secret@api.devnet.solana.com' : arg),
    cli.map((arg) => arg === cli[4] ? 'https://api.devnet.solana.com/#secret' : arg),
  ].map((args) => ({ args })))('rejects invalid arguments before runtime creation: $args', async ({ args }) => {
    const factory = vi.fn()
    await expect(runDevnetFixturesCli(args, factory)).rejects.toThrow()
    expect(factory).not.toHaveBeenCalled()
  })

  it('never imports local fixtures, local key records or key generation helpers', () => {
    const source = readFileSync(new URL('./devnet-fixtures.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/from ['"]\.\/lib['"]|import\(['"]\.\/lib['"]\)|loadDevWallets|createKeyPair|generateKeyPair|from ['"]\.\/fixtures['"]/)
    expect(source).not.toContain('process.env')
  })
})
