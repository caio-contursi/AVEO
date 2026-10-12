import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { blockhash, getAddressDecoder, getBase64Encoder, getSignatureFromTransaction, getTransactionDecoder,
  type Instruction, type Rpc, type SolanaRpcApi } from '@solana/kit'
import { AVEO_DEVNET_HOOK_PROGRAM_ID, SAS_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '../src/api/constants'
import { DEVNET_GENESIS_HASH } from './devnet-preflight'
import { createDevnetRuntime, validateDevnetDirectory, validateDevnetEndpoints } from './devnet-runtime'

const dirs: string[] = []
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const addr = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n))
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'aveo-devnet-runtime-unit-'))
  dirs.push(directory)
  let wire = '', funded = false
  const methods = {
    getGenesisHash: vi.fn(async () => DEVNET_GENESIS_HASH),
    getMultipleAccounts: vi.fn(async () => ({ context: { slot: 42n }, value: [1, 2, 3].map(() =>
      ({ executable: true, owner: 'BPFLoaderUpgradeab1e11111111111111111111111' })) })),
    getLatestBlockhash: vi.fn(async () => ({ value: { blockhash: blockhash(addr(9)), lastValidBlockHeight: 999n } })),
    simulateTransaction: vi.fn(async () => ({ value: { err: null as unknown } })),
    sendTransaction: vi.fn(async (value: string) => {
      wire = value
      return getSignatureFromTransaction(getTransactionDecoder().decode(getBase64Encoder().encode(wire)))
    }),
    getSignatureStatuses: vi.fn(async () => ({ value: [{ confirmationStatus: 'confirmed', err: null, slot: 42n }] })),
    getTransaction: vi.fn(async () => ({ slot: 42n, meta: { err: null }, transaction: [wire, 'base64'] })),
    getBalance: vi.fn(async () => ({ context: { slot: 42n }, value: funded ? 1_000_000_000n : 0n })),
    requestAirdrop: vi.fn(async () => { funded = true; return '1'.repeat(64) }),
  }
  const api = Object.fromEntries(Object.entries(methods).map(([name, send]) => [name, vi.fn((...args: unknown[]) => ({
    send: (sendOptions: unknown) => Reflect.apply(send, undefined, [...args, sendOptions]),
  }))]))
  const options = { directory, rpcUrl: 'https://api.devnet.solana.com', wsUrl: 'wss://api.devnet.solana.com' }
  const create = () => createDevnetRuntime(options, { rpc: api as unknown as Rpc<SolanaRpcApi> })
  const journal = () => JSON.parse(readFileSync(path.join(directory, 'devnet-run.jsonl'), 'utf8').trim().split('\n').at(-1)!)
  return { directory, options, methods, api, create, journal }
}
const instruction: Instruction = { programAddress: addr(8), data: new Uint8Array([1]) }

describe('dedicated synthetic devnet runtime', () => {
  it('retries delayed transaction indexing read-only without a second submission', async () => {
    const f = fixture(), runtime = await f.create()
    const { signer } = await runtime.newWallet('issuer', 'Issuer', 'issuer')
    f.methods.getTransaction.mockResolvedValueOnce(null as never)
    await runtime.send(signer, [instruction])
    expect(f.methods.sendTransaction).toHaveBeenCalledOnce()
    expect(f.methods.getTransaction).toHaveBeenCalledTimes(2)
    expect(f.journal().operations[0].phase).toBe('confirmed')
  })
  it('observes externally funded issuer without a faucet or funding signature', async () => {
    const f = fixture()
    const notify = vi.fn()
    f.methods.getBalance.mockResolvedValue({ context: { slot: 42n }, value: 1_000_000_000n })
    const runtime = await createDevnetRuntime({ ...f.options, externalIssuerFunding: true }, { rpc: f.api as unknown as Rpc<SolanaRpcApi>, onExternalFundingRequired: notify })
    const issuer = await runtime.newWallet('issuer', 'Issuer', 'issuer')
    await runtime.fund(issuer.signer.address, 1_000_000_000n)
    expect(notify).toHaveBeenCalledWith(issuer.signer.address)
    expect(f.methods.requestAirdrop).not.toHaveBeenCalled()
    expect(f.methods.sendTransaction).not.toHaveBeenCalled()
    expect(f.journal().operations[0]).toMatchObject({ kind: 'external-funding-observation', phase: 'confirmed', slot: 42 })
    expect(f.journal().operations[0].signature).toBeUndefined()
    const investor = await runtime.newWallet('X', 'Investor', 'investor')
    await runtime.fund(investor.signer.address, 50_000_000n)
    expect(f.methods.sendTransaction).toHaveBeenCalledOnce()
  })

  it('stops external funding on network change without falling back to a faucet', async () => {
    const f = fixture()
    const runtime = await createDevnetRuntime({ ...f.options, externalIssuerFunding: true }, { rpc: f.api as unknown as Rpc<SolanaRpcApi>, onExternalFundingRequired: vi.fn() })
    const issuer = await runtime.newWallet('issuer', 'Issuer', 'issuer')
    f.methods.getBalance.mockImplementation(async () => {
      f.methods.getGenesisHash.mockResolvedValue('wrong-network')
      return { context: { slot: 42n }, value: 1_000_000_000n }
    })
    await expect(runtime.fund(issuer.signer.address, 1_000_000_000n)).rejects.toThrow()
    expect(f.journal().status).toBe('stopped')
    expect(f.methods.requestAirdrop).not.toHaveBeenCalled()
    expect(f.methods.sendTransaction).not.toHaveBeenCalled()
  })

  it('rejects stale external funding reads and permanently blocks later operations', async () => {
    const f = fixture()
    f.methods.getBalance.mockResolvedValueOnce({ context: { slot: 42n }, value: 0n }).mockResolvedValue({ context: { slot: 41n }, value: 1_000_000_000n })
    const runtime = await createDevnetRuntime({ ...f.options, externalIssuerFunding: true }, { rpc: f.api as unknown as Rpc<SolanaRpcApi>, onExternalFundingRequired: vi.fn() })
    const issuer = await runtime.newWallet('issuer', 'Issuer', 'issuer')
    await expect(runtime.fund(issuer.signer.address, 1_000_000_000n)).rejects.toThrow()
    await expect(runtime.newWallet('X', 'Investor', 'investor')).rejects.toThrow()
    expect(f.methods.requestAirdrop).not.toHaveBeenCalled()
  })
  it.each(['https://api.mainnet-beta.solana.com', 'http://127.0.0.1:8899', 'https://api.devnet.solana.com/proxy',
    'https://secret@api.devnet.solana.com', 'https://api.devnet.solana.com?key=secret'])('rejects endpoint %s before RPC or private artifacts', async (rpcUrl) => {
    const f = fixture(); f.options.rpcUrl = rpcUrl
    await expect(f.create()).rejects.toThrow('Synthetic devnet bootstrap stopped')
    expect(f.methods.getGenesisHash).not.toHaveBeenCalled()
    expect(existsSync(path.join(f.directory, 'devnet-run.jsonl'))).toBe(false)
  })

  it('rejects a non-devnet websocket and nonprivate or aliased directory', () => {
    const f = fixture()
    expect(() => validateDevnetEndpoints(f.options.rpcUrl, 'wss://api.mainnet-beta.solana.com')).toThrow()
    chmodSync(f.directory, 0o755)
    expect(() => validateDevnetDirectory(f.directory)).toThrow()
    chmodSync(f.directory, 0o700)
    const alias = path.join(f.directory, 'alias'); symlinkSync(f.directory, alias)
    expect(() => validateDevnetDirectory(alias)).toThrow()
  })

  it('rejects wrong genesis before program reads or wallet creation', async () => {
    const f = fixture(); f.methods.getGenesisHash.mockResolvedValue('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')
    await expect(f.create()).rejects.toThrow()
    expect(f.methods.getMultipleAccounts).not.toHaveBeenCalled()
    expect(existsSync(path.join(f.directory, 'devnet-wallets.jsonl'))).toBe(false)
  })

  it.each(['absent', 'not-executable', 'wrong-loader', 'short-array'] as const)('rejects %s program metadata before keys or funds', async (kind) => {
    const f = fixture()
    const result = await f.methods.getMultipleAccounts()
    if (kind === 'absent') result.value[0] = null as never
    if (kind === 'not-executable') result.value[0]!.executable = false
    if (kind === 'wrong-loader') result.value[0]!.owner = addr(8)
    if (kind === 'short-array') result.value.pop()
    f.methods.getMultipleAccounts.mockResolvedValue(result)
    await expect(f.create()).rejects.toThrow()
    expect(f.methods.requestAirdrop).not.toHaveBeenCalled()
    expect(existsSync(path.join(f.directory, 'devnet-run.jsonl'))).toBe(false)
  })

  it('creates exclusive private run/key artifacts without reading a preexisting local wallet', async () => {
    const f = fixture()
    writeFileSync(path.join(f.directory, 'wallets.json'), 'do not load this wallet')
    const runtime = await f.create()
    const wallet = await runtime.newWallet('issuer', 'Synthetic issuer', 'issuer')
    expect(wallet.record.secretKey.length).toBe(64)
    expect(statSync(path.join(f.directory, 'devnet-wallets.jsonl')).mode & 0o777).toBe(0o600)
    expect(statSync(path.join(f.directory, 'devnet-run.jsonl')).mode & 0o777).toBe(0o600)
    expect(readFileSync(path.join(f.directory, 'wallets.json'), 'utf8')).toBe('do not load this wallet')
    await expect(f.create()).rejects.toThrow()
    expect(f.methods.requestAirdrop).not.toHaveBeenCalled()
  })

  it('rejects repeated wallet identifiers without overwriting custody', async () => {
    const f = fixture(), runtime = await f.create()
    await runtime.newWallet('issuer', 'Issuer', 'issuer')
    const before = readFileSync(path.join(f.directory, 'devnet-wallets.jsonl'), 'utf8')
    await expect(runtime.newWallet('issuer', 'Other', 'issuer')).rejects.toThrow()
    expect(readFileSync(path.join(f.directory, 'devnet-wallets.jsonl'), 'utf8') === before).toBe(true)
    await expect(runtime.newWallet('X', 'X', 'investor')).rejects.toThrow()
  })

  it('persists exact message and signature before the one permitted raw send', async () => {
    const f = fixture(), runtime = await f.create()
    const { signer } = await runtime.newWallet('issuer', 'Issuer', 'issuer')
    const original = f.methods.sendTransaction.getMockImplementation()!
    f.methods.sendTransaction.mockImplementation(async (wire) => {
      const operation = f.journal().operations[0]
      expect(operation).toMatchObject({ phase: 'submitting', payer: signer.address })
      expect(operation.signature).toBe(getSignatureFromTransaction(getTransactionDecoder().decode(getBase64Encoder().encode(wire))))
      expect(operation.messageFingerprint).toMatch(/^[a-f0-9]{64}$/)
      return original(wire)
    })
    const signature = await runtime.send(signer, [instruction])
    expect(f.methods.sendTransaction).toHaveBeenCalledOnce()
    expect(f.api.sendTransaction).toHaveBeenCalledWith(expect.any(String),
      { encoding: 'base64', preflightCommitment: 'confirmed', skipPreflight: false, maxRetries: 0n })
    expect(f.journal().operations[0]).toMatchObject({ phase: 'confirmed', signature, slot: 42 })
  })

  it('retains an ambiguous original signature and blocks every later mutation without retry', async () => {
    const f = fixture(), runtime = await f.create()
    const { signer } = await runtime.newWallet('issuer', 'Issuer', 'issuer')
    f.methods.sendTransaction.mockRejectedValue(new Error('private provider credentials'))
    await expect(runtime.send(signer, [instruction])).rejects.toThrow('Synthetic devnet bootstrap stopped')
    expect(f.journal()).toMatchObject({ status: 'stopped', operations: [{ phase: 'unknown', signature: expect.any(String) }] })
    await expect(runtime.send(signer, [instruction])).rejects.toThrow()
    await expect(runtime.fund(signer.address, 1n)).rejects.toThrow()
    await expect(runtime.newWallet('X', 'X', 'investor')).rejects.toThrow()
    expect(f.methods.sendTransaction).toHaveBeenCalledOnce()
    expect(f.methods.requestAirdrop).not.toHaveBeenCalled()
    expect(JSON.stringify(f.journal())).not.toContain('private provider credentials')
  })

  it('does not broadcast failed simulation and leaves private evidence', async () => {
    const f = fixture(), runtime = await f.create()
    const { signer } = await runtime.newWallet('issuer', 'Issuer', 'issuer')
    f.methods.simulateTransaction.mockResolvedValue({ value: { err: { InstructionError: [0, 'InvalidAccountData'] } } })
    await expect(runtime.send(signer, [instruction])).rejects.toThrow()
    expect(f.methods.sendTransaction).not.toHaveBeenCalled()
    expect(f.journal().operations[0]).toMatchObject({ phase: 'unknown', signature: expect.any(String) })
  })

  it('stops before signing when the endpoint changes network after startup', async () => {
    const f = fixture(), runtime = await f.create()
    const { signer } = await runtime.newWallet('issuer', 'Issuer', 'issuer')
    f.methods.getGenesisHash.mockResolvedValue('11111111111111111111111111111111')
    await expect(runtime.send(signer, [instruction])).rejects.toThrow()
    expect(f.methods.getLatestBlockhash).not.toHaveBeenCalled()
    expect(f.methods.sendTransaction).not.toHaveBeenCalled()
    expect(f.journal().status).toBe('stopped')
  })

  it('stops before broadcast if the endpoint changes after signing', async () => {
    const f = fixture(), runtime = await f.create()
    const { signer } = await runtime.newWallet('issuer', 'Issuer', 'issuer')
    f.methods.simulateTransaction.mockImplementation(async () => {
      f.methods.getGenesisHash.mockResolvedValue('11111111111111111111111111111111')
      return { value: { err: null } }
    })
    await expect(runtime.send(signer, [instruction])).rejects.toThrow()
    expect(f.methods.sendTransaction).not.toHaveBeenCalled()
    expect(f.journal().operations[0].signature).toBeDefined()
  })

  it('blocks a foreign payer before any signing preparation', async () => {
    const f = fixture(), runtime = await f.create()
    await expect(runtime.send({ address: addr(8) } as never, [instruction])).rejects.toThrow()
    expect(f.methods.getLatestBlockhash).not.toHaveBeenCalled()
  })

  it('uses a single bounded faucet request only for the dedicated issuer', async () => {
    const f = fixture(), runtime = await f.create()
    const issuer = await runtime.newWallet('issuer', 'Issuer', 'issuer')
    const investor = await runtime.newWallet('X', 'X', 'investor')
    await runtime.fund(issuer.signer.address, 1_000_000_000n)
    await runtime.fund(investor.signer.address, 50_000_000n)
    expect(f.methods.requestAirdrop).toHaveBeenCalledOnce()
    expect(f.methods.sendTransaction).toHaveBeenCalledOnce()
    expect(f.journal().operations.map((entry: { phase: string }) => entry.phase)).toEqual(['confirmed', 'confirmed'])
  })

  it('retains ambiguous faucet request and forbids a second request', async () => {
    const f = fixture(), runtime = await f.create()
    const issuer = await runtime.newWallet('issuer', 'Issuer', 'issuer')
    f.methods.requestAirdrop.mockRejectedValue(new Error('provider failed'))
    await expect(runtime.fund(issuer.signer.address, 1_000_000_000n)).rejects.toThrow()
    await expect(runtime.fund(issuer.signer.address, 1_000_000_000n)).rejects.toThrow()
    expect(f.methods.requestAirdrop).toHaveBeenCalledOnce()
    expect(f.journal().operations[0]).toMatchObject({ kind: 'airdrop', phase: 'unknown' })
  })

  it('refuses a faucet request if the network changes while reading the starting balance', async () => {
    const f = fixture(), runtime = await f.create()
    const issuer = await runtime.newWallet('issuer', 'Issuer', 'issuer')
    f.methods.getBalance.mockImplementation(async () => {
      f.methods.getGenesisHash.mockResolvedValue('11111111111111111111111111111111')
      return { context: { slot: 42n }, value: 0n }
    })
    await expect(runtime.fund(issuer.signer.address, 1_000_000_000n)).rejects.toThrow()
    expect(f.methods.requestAirdrop).not.toHaveBeenCalled()
    expect(f.journal()).toMatchObject({ status: 'stopped', operations: [{ phase: 'unknown' }] })
  })

  it('appends durable snapshots without destroying earlier keys or signed operation records', async () => {
    const f = fixture(), runtime = await f.create()
    const issuer = await runtime.newWallet('issuer', 'Issuer', 'issuer')
    const keyFile = path.join(f.directory, 'devnet-wallets.jsonl')
    const before = readFileSync(keyFile, 'utf8')
    await runtime.newWallet('X', 'X', 'investor')
    expect(readFileSync(keyFile, 'utf8').startsWith(before)).toBe(true)
    const snapshots = readFileSync(keyFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(snapshots.map((snapshot) => snapshot.wallets.length)).toEqual([0, 1, 2])
    await runtime.send(issuer.signer, [instruction])
    const journalFile = path.join(f.directory, 'devnet-run.jsonl')
    const journalBefore = readFileSync(journalFile, 'utf8')
    f.methods.sendTransaction.mockRejectedValue(new Error('lost response'))
    await expect(runtime.send(issuer.signer, [instruction])).rejects.toThrow()
    expect(readFileSync(journalFile, 'utf8').startsWith(journalBefore)).toBe(true)
    const operations = f.journal().operations
    expect(operations[0]).toMatchObject({ phase: 'confirmed', signature: expect.any(String) })
    expect(operations[1]).toMatchObject({ phase: 'unknown', signature: expect.any(String) })
  })

  it('forbids publishing an empty or stopped bootstrap as a deployment', async () => {
    const f = fixture(), runtime = await f.create()
    expect(() => runtime.writePublicDeployment({} as never)).toThrow()
    expect(existsSync(path.join(f.directory, 'deployment.json'))).toBe(false)
  })

  it('rejects a key-file replacement before signing', async () => {
    const f = fixture(), runtime = await f.create()
    const file = path.join(f.directory, 'devnet-wallets.jsonl')
    chmodSync(file, 0o644)
    await expect(runtime.newWallet('issuer', 'Issuer', 'issuer')).rejects.toThrow()
    expect(f.methods.sendTransaction).not.toHaveBeenCalled()
  })

  it('bounds a lost send response and never submits again after late completion', async () => {
    const f = fixture(), runtime = await f.create()
    const { signer } = await runtime.newWallet('issuer', 'Issuer', 'issuer')
    let release!: (signature: never) => void
    let entered!: () => void
    const ready = new Promise<void>((resolve) => { entered = resolve })
    f.methods.sendTransaction.mockImplementation(() => new Promise((resolve) => { release = resolve; entered() }))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const rejected = expect(runtime.send(signer, [instruction])).rejects.toThrow()
    // Await the real WebCrypto signer reaching transport before advancing its deadline.
    await ready
    expect(release).toBeDefined()
    await vi.advanceTimersByTimeAsync(15_000)
    await rejected
    const retained = JSON.stringify(f.journal())
    release('1'.repeat(64) as never)
    await vi.advanceTimersByTimeAsync(1)
    expect(JSON.stringify(f.journal())).toBe(retained)
    expect(f.methods.sendTransaction).toHaveBeenCalledOnce()
    expect(f.methods.getSignatureStatuses).not.toHaveBeenCalled()
  })

  it('checks the fixed three program identities without using a deployment manifest', async () => {
    const f = fixture(); await f.create()
    expect(f.api.getMultipleAccounts).toHaveBeenCalledWith([AVEO_DEVNET_HOOK_PROGRAM_ID, SAS_PROGRAM_ID, TOKEN_2022_PROGRAM_ID],
      { commitment: 'confirmed', encoding: 'base64', dataSlice: { offset: 0, length: 0 } })
  })
})
