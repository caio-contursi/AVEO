import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { blockhash, compileTransaction, createTransactionMessage, getAddressDecoder, getBase58Decoder,
  getBase64EncodedWireTransaction, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
  type SignatureBytes } from '@solana/kit'
import type { ApiContext } from '../src/api/context'
import { AVEO_HOOK_PROGRAM_ID, SAS_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '../src/api/constants'
import { messageFingerprint } from '../src/api/submission-proof'
import { parseDeployment } from '../src/config/deployment'
import { SUBMISSION_INTENT_STORAGE_KEY, SubmissionIntentStore } from '../src/features/operations/submission-intent'
import { createLocalIntentStorage, openLocalIntentStorage } from './local-intent-storage'
import { inspectLocalIntent } from './local-intent-inspect'
import { localIntentRead } from './local-intent-read'

vi.mock('./lib', () => { throw new Error('Wallet-loading library must not be imported') })
const addr = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n))
const genesis = '9TsPJrMdoJAFz45vk1wjoDu7pKPmBB1BzDJzCzfodBNP'
const signatureBytes = new Uint8Array(64).fill(4) as SignatureBytes
const signature = getBase58Decoder().decode(signatureBytes)
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const finish of cleanup.splice(0).reverse()) await finish(); vi.restoreAllMocks() })

async function fixture(rpcUrl = 'http://127.0.0.1:18899') {
  const directory = mkdtempSync(path.join(tmpdir(), 'aveo-intent-inspection-test-'))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const deployment = parseDeployment({ version: 1, cluster: 'localnet', generatedAt: '2026-10-11T00:00:00Z',
    programs: { aveoHook: AVEO_HOOK_PROGRAM_ID, sas: SAS_PROGRAM_ID, token2022: TOKEN_2022_PROGRAM_ID },
    proofDomain: 'ab'.repeat(32), issuer: addr(1),
    verifiers: [{ id: 'v', label: 'Verifier', authority: addr(2), credential: addr(3), schema: addr(4) }],
    assets: [{ id: 'alfa', label: 'Alfa', symbol: 'TEST', mint: addr(5), decimals: 0 }],
    wallets: [{ id: 'X', label: 'X', address: addr(6), role: 'investor' },
      { id: 'treasury', label: 'Treasury', address: addr(7), role: 'treasury' }],
  })
  writeFileSync(path.join(directory, 'deployment.json'), JSON.stringify(deployment), { mode: 0o600 })
  const ctx = { cluster: 'localnet', rpcUrl, programId: AVEO_HOOK_PROGRAM_ID, commitment: 'confirmed',
    deployment, rpc: {} } as ApiContext
  const { file, storage } = createLocalIntentStorage(directory)
  const store = new SubmissionIntentStore(storage, async (operation) => { await operation() })
  const attempt = await store.reserve(ctx, addr(6), 'transfer')
  const unsigned = compileTransaction(setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(addr(8)), lastValidBlockHeight: 100n },
    setTransactionMessageFeePayer(addr(6), createTransactionMessage({ version: 0 }))))
  const wire = getBase64EncodedWireTransaction({ ...unsigned, signatures: { [addr(6)]: signatureBytes } })
  await store.startWallet(attempt, await messageFingerprint(unsigned.messageBytes))
  await store.attachSignature(attempt, signature)
  const raw = readFileSync(file, 'utf8')
  const chain = { slot: 42, meta: { err: null as unknown }, transaction: [wire, 'base64'] }
  const read = vi.fn<typeof localIntentRead>().mockImplementation(async (_url, method) => method === 'getGenesisHash' ? genesis : chain)
  const readonly = new SubmissionIntentStore({ getItem: storage.getItem, setItem: () => { throw new Error('Forbidden write') } },
    async (operation) => { await operation() })
  return { ctx, store: readonly, writableStore: store, attempt, file, storage, directory, raw, chain, read, unsigned }
}

describe('observational local intent inspection', () => {
  it.each(['confirmed', 'failed'] as const)('verifies %s original bytes without clearing or rewriting the gate', async (status) => {
    const f = await fixture()
    if (status === 'failed') f.chain.meta.err = { InstructionError: [0, 'Custom'] }
    expect(await inspectLocalIntent({ ...f, expectedGenesis: genesis })).toEqual({ version: 1, scope: 'localnet-synthetic',
      status, evidenceOnly: true, gateReleased: false, signingCalls: 0, submissionCalls: 0, signature, slot: 42 })
    expect(f.read.mock.calls.map((call) => call[1])).toEqual(['getGenesisHash', 'getTransaction', 'getGenesisHash'])
    expect(readFileSync(f.file, 'utf8')).toBe(f.raw)
    expect(f.store.getSnapshot().intent).toBeDefined()
  })

  it.each(['url', 'deployment', 'commitment', 'program', 'cluster'])('rejects changed %s context before RPC', async (kind) => {
    const f = await fixture()
    if (kind === 'url') f.ctx.rpcUrl = 'http://127.0.0.1:18898'
    if (kind === 'deployment') f.ctx.deployment.generatedAt = '2026-10-10T00:00:00Z'
    if (kind === 'commitment') f.ctx.commitment = 'processed'
    if (kind === 'program') f.ctx.programId = addr(8)
    if (kind === 'cluster') f.ctx.cluster = 'devnet'
    const result = await inspectLocalIntent({ ...f, expectedGenesis: genesis })
    expect(['context-mismatch', 'blocked']).toContain(result.status)
    expect(f.read).not.toHaveBeenCalled()
    expect(readFileSync(f.file, 'utf8')).toBe(f.raw)
  })

  it.each(['public', 'wrong', 'changing'] as const)('rejects %s genesis without writing the intent', async (kind) => {
    const f = await fixture()
    let pins = 0
    f.read.mockImplementation(async (_url, method) => {
      if (method === 'getTransaction') return f.chain
      return kind === 'changing' && ++pins === 1 ? genesis : '11111111111111111111111111111111'
    })
    const expectedGenesis = kind === 'public' ? 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' : genesis
    expect((await inspectLocalIntent({ ...f, expectedGenesis })).status).toBe('blocked')
    if (kind === 'public') expect(f.read).not.toHaveBeenCalled()
    if (kind === 'wrong') expect(f.read.mock.calls.map((call) => call[1])).toEqual(['getGenesisHash'])
    expect(readFileSync(f.file, 'utf8')).toBe(f.raw)
  })

  it.each(['missing', 'different-message', 'different-signature', 'malformed'] as const)('reports unknown for %s transaction evidence', async (kind) => {
    const f = await fixture()
    if (kind === 'different-message') {
      const message = compileTransaction(setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(addr(9)), lastValidBlockHeight: 101n },
        setTransactionMessageFeePayer(addr(6), createTransactionMessage({ version: 0 }))))
      f.chain.transaction[0] = getBase64EncodedWireTransaction({ ...message, signatures: { [addr(6)]: signatureBytes } })
    }
    if (kind === 'different-signature') f.chain.transaction[0] = getBase64EncodedWireTransaction({ ...f.unsigned,
      signatures: { [addr(6)]: new Uint8Array(64).fill(5) as SignatureBytes } })
    if (kind === 'malformed') f.chain.transaction = ['invalid', 'base64']
    f.read.mockImplementation(async (_url, method) => method === 'getGenesisHash' ? genesis : kind === 'missing' ? null : f.chain)
    expect((await inspectLocalIntent({ ...f, expectedGenesis: genesis })).status).toBe('unknown')
    expect(readFileSync(f.file, 'utf8')).toBe(f.raw)
  })

  it('verifies a signatureless candidate without persisting the supplied signature', async () => {
    const f = await fixture()
    const raw = JSON.parse(f.raw)
    delete raw.signature
    f.storage.setItem(SUBMISSION_INTENT_STORAGE_KEY, JSON.stringify(raw))
    const storage = openLocalIntentStorage(f.file)
    const store = new SubmissionIntentStore(storage, async (operation) => { await operation() })
    expect((await inspectLocalIntent({ ...f, store, expectedGenesis: genesis, signature })).status).toBe('confirmed')
    expect(JSON.parse(readFileSync(f.file, 'utf8'))).toEqual(raw)
  })

  it.each([null, false, '', '42', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects raw slot %s despite matching transaction bytes', async (slot) => {
    const f = await fixture()
    f.read.mockImplementation(async (_url, method) => method === 'getGenesisHash' ? genesis : { ...f.chain, slot })
    expect((await inspectLocalIntent({ ...f, expectedGenesis: genesis })).status).toBe('unknown')
    expect(readFileSync(f.file, 'utf8')).toBe(f.raw)
  })

  it.each([undefined, false, 0, '', [], {}, { InstructionError: [0, false] },
    { InstructionError: [-1, 'Custom'] }, { InstructionError: [0, { Custom: -1 }] }])('rejects malformed error metadata %s', async (err) => {
    const f = await fixture()
    f.chain.meta.err = err
    expect((await inspectLocalIntent({ ...f, expectedGenesis: genesis })).status).toBe('unknown')
    expect(readFileSync(f.file, 'utf8')).toBe(f.raw)
  })

  it('recognizes a structured program rejection without releasing the gate', async () => {
    const f = await fixture()
    f.chain.meta.err = { InstructionError: [1, { Custom: 6000 }] }
    expect((await inspectLocalIntent({ ...f, expectedGenesis: genesis })).status).toBe('failed')
    expect(readFileSync(f.file, 'utf8')).toBe(f.raw)
  })

  it('rejects a supplied signature that retargets a known operation', async () => {
    const f = await fixture()
    expect((await inspectLocalIntent({ ...f, expectedGenesis: genesis, signature: '1'.repeat(64) })).status).toBe('invalid-signature')
    expect(f.read).not.toHaveBeenCalled()
  })

  it('does not claim confirmation if the intent changes during transaction lookup', async () => {
    const f = await fixture()
    f.read.mockImplementation(async (_url, method) => {
      if (method === 'getGenesisHash') return genesis
      f.storage.setItem(SUBMISSION_INTENT_STORAGE_KEY, 'null')
      return f.chain
    })
    expect((await inspectLocalIntent({ ...f, expectedGenesis: genesis })).status).toBe('blocked')
  })

  it.each(['empty', 'invalid', 'reserved'] as const)('reports %s storage without consulting RPC', async (kind) => {
    const f = await fixture()
    if (kind === 'empty') f.storage.setItem(SUBMISSION_INTENT_STORAGE_KEY, 'null')
    else if (kind === 'invalid') f.storage.setItem(SUBMISSION_INTENT_STORAGE_KEY, '{')
    else {
      const raw = JSON.parse(f.raw)
      raw.phase = 'reserved'; delete raw.messageFingerprint; delete raw.signature
      f.storage.setItem(SUBMISSION_INTENT_STORAGE_KEY, JSON.stringify(raw))
    }
    const store = new SubmissionIntentStore(openLocalIntentStorage(f.file), async (operation) => { await operation() })
    expect((await inspectLocalIntent({ ...f, store, expectedGenesis: genesis })).status).toBe(kind === 'empty' ? 'empty' : 'blocked')
    expect(f.read).not.toHaveBeenCalled()
  })

  it.each(['confirmed', 'failed', 'unknown', 'wrong-genesis'] as const)('executes the actual package command in a new process for %s, with no wallet file', async (kind) => {
    let reply: (method: string) => unknown = () => genesis
    const methods: string[] = []
    const server = createServer((request, response) => {
      let raw = ''
      request.on('data', (chunk) => { raw += chunk })
      request.on('end', () => {
        const body = JSON.parse(raw)
        methods.push(body.method)
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: reply(body.method) }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
    const bound = server.address()
    if (!bound || typeof bound === 'string') throw new Error('Missing loopback fixture')
    const f = await fixture(`http://127.0.0.1:${bound.port}`)
    if (kind === 'failed') f.chain.meta.err = { InstructionError: [0, 'Custom'] }
    reply = (method) => method === 'getGenesisHash' ? kind === 'wrong-genesis' ? '11111111111111111111111111111111' : genesis
      : kind === 'unknown' ? null : f.chain
    const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    let stdout = '', stderr = '', code = 0
    try {
      const result = await promisify(execFile)('pnpm', ['--silent', 'local:intent:inspect', f.file], { cwd: appRoot,
        env: { ...process.env, AVEO_RPC_URL: f.ctx.rpcUrl, AVEO_WS_URL: 'ws://127.0.0.1:8900',
          AVEO_CLUSTER: 'localnet', AVEO_LOCAL_GENESIS_HASH: genesis }, timeout: 15_000 })
      stdout = result.stdout; stderr = result.stderr
    } catch (error) {
      const e = error as { stdout: string; stderr: string; code: number }
      stdout = e.stdout; stderr = e.stderr; code = e.code
    }
    expect(code).toBe(kind === 'confirmed' ? 0 : kind === 'failed' ? 1 : 2)
    expect(stderr).toBe('')
    const result = JSON.parse(stdout.trim().split('\n').at(-1)!)
    expect(result).toMatchObject({ status: kind === 'wrong-genesis' ? 'blocked' : kind,
      evidenceOnly: true, gateReleased: false, signingCalls: 0, submissionCalls: 0 })
    expect(methods).toEqual(kind === 'wrong-genesis' ? ['getGenesisHash'] : ['getGenesisHash', 'getTransaction', 'getGenesisHash'])
    expect(readFileSync(f.file, 'utf8')).toBe(f.raw)
    expect(existsSync(path.join(f.directory, 'wallets.json'))).toBe(false)
    expect(Object.keys(result).sort()).not.toContain('rpcUrl')
  }, 20_000)
})
