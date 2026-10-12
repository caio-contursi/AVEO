import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile, realpath } from 'node:fs/promises'
import { AVEO_HOOK_PROGRAM_ID, SAS_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '../src/api/constants'
import { parseDeployment, type Deployment } from '../src/config/deployment'
import { checkDevnetPrograms, DEVNET_GENESIS_HASH, RPC_TIMEOUT_MS, runDevnetPreflightCli } from './devnet-preflight'

// CLI tests exercise orchestration independently of the public-manifest module's own tests.
vi.mock('./public-manifest', () => ({ parsePublicManifest: (raw: unknown) => parseDeployment(raw) }))
vi.mock('node:fs/promises', () => ({ readFile: vi.fn(), realpath: vi.fn() }))

const manifest: Deployment = {
  version: 1, cluster: 'devnet', generatedAt: '2026-10-10T12:00:00.000Z',
  programs: { aveoHook: AVEO_HOOK_PROGRAM_ID, sas: SAS_PROGRAM_ID, token2022: TOKEN_2022_PROGRAM_ID },
  proofDomain: 'ab'.repeat(32), issuer: AVEO_HOOK_PROGRAM_ID,
  verifiers: [{ id: 'verifier', label: 'Verifier', authority: SAS_PROGRAM_ID, credential: SAS_PROGRAM_ID, schema: SAS_PROGRAM_ID }],
  assets: [{ id: 'asset', label: 'Asset', symbol: 'TEST', mint: AVEO_HOOK_PROGRAM_ID, decimals: 6 }],
  wallets: [{ id: 'treasury', label: 'Treasury', address: AVEO_HOOK_PROGRAM_ID, role: 'treasury' }],
}
const endpoint = 'https://rpc.example.invalid'
type Request = { jsonrpc: string; id: number; method: string; params: unknown[] }
const account = (executable = true) => ({ context: { slot: 123 }, value: {
  executable, owner: AVEO_HOOK_PROGRAM_ID, lamports: 1, rentEpoch: Number('18446744073709551615'), data: ['', 'base64'],
} })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
function mockRpc(result: (request: Request) => unknown = () => account(), genesis = DEVNET_GENESIS_HASH) {
  return vi.fn<typeof fetch>(async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as Request
    return json({ jsonrpc: '2.0', id: request.id, result: request.method === 'getGenesisHash' ? genesis : result(request) })
  })
}
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

describe('devnet program preflight', () => {
  it('reports exactly the three manifest programs using only public read methods', async () => {
    const fetchImpl = mockRpc()
    const report = await checkDevnetPrograms(manifest, endpoint, fetchImpl)
    expect(report).toMatchObject({ scope: 'devnet-program-preflight', status: 'PASS', cluster: {
      manifest: 'devnet', observed: 'devnet', genesisHash: DEVNET_GENESIS_HASH, verified: true, error: null,
    } })
    expect(report.programs.map((program) => program.address)).toEqual(Object.values(manifest.programs))
    expect(report.programs.every((program) => program.status === 'PASS' && program.exists && program.executable && program.slot === 123)).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(4)
    const requests = fetchImpl.mock.calls.map(([url, init]) => {
      expect(url).toBe(endpoint)
      expect(init).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json' }, signal: expect.any(AbortSignal) })
      return JSON.parse(String(init?.body)) as Request
    })
    expect(requests.map((request) => request.method)).toEqual(['getGenesisHash', 'getAccountInfo', 'getAccountInfo', 'getAccountInfo'])
    expect(requests.slice(1).map((request) => request.params)).toEqual(Object.values(manifest.programs).map((address) => [address, {
      encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 0, length: 0 },
    }]))
  })

  it('honestly reports an absent deployment while checking other programs', async () => {
    const report = await checkDevnetPrograms(manifest, endpoint, mockRpc((request) => request.params[0] === manifest.programs.aveoHook ? { context: { slot: 123 }, value: null } : account()))
    expect(report.status).toBe('FAIL')
    expect(report.programs[0]).toMatchObject({ status: 'FAIL', exists: false, executable: null, error: { code: 'missing-program' } })
    expect(report.programs.slice(1).every((program) => program.status === 'PASS')).toBe(true)
  })

  it('rejects a present non-executable program', async () => {
    const report = await checkDevnetPrograms(manifest, endpoint, mockRpc(() => account(false)))
    expect(report.status).toBe('FAIL')
    expect(report.programs[0]).toMatchObject({ exists: true, executable: false, error: { code: 'non-executable' } })
  })

  it('rejects a localnet manifest before any RPC request', async () => {
    const fetchImpl = mockRpc()
    const report = await checkDevnetPrograms({ ...manifest, cluster: 'localnet' }, endpoint, fetchImpl)
    expect(report.cluster.error?.code).toBe('wrong-cluster')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    ['mainnet-beta', '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'],
    ['testnet', '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY'],
    ['unknown', '11111111111111111111111111111111'],
    ['unknown', 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBH'],
  ])('rejects %s genesis even if the URL claims devnet', async (observed, genesis) => {
    const fetchImpl = mockRpc(undefined, genesis)
    const report = await checkDevnetPrograms(manifest, 'https://devnet.example.invalid', fetchImpl)
    expect(report.cluster).toMatchObject({ observed, verified: false, genesisHash: genesis, error: { code: 'wrong-cluster' } })
    expect(report.programs.every((program) => program.status === 'NOT_RUN' && program.exists === null)).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each([null, 123, '', 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1'])('rejects invalid or truncated genesis %j', async (genesis) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ jsonrpc: '2.0', id: 1, result: genesis }))
    expect((await checkDevnetPrograms(manifest, endpoint, fetchImpl)).cluster.error?.code).toBe('payload')
  })

  it.each([
    null, [], {}, { jsonrpc: '1.0', id: 1, result: DEVNET_GENESIS_HASH },
    { jsonrpc: '2.0', id: 99, result: DEVNET_GENESIS_HASH },
    { jsonrpc: '2.0', id: 1 },
    { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'unavailable' } },
    { jsonrpc: '2.0', id: 1, error: { code: 'bad', message: 'bad' } },
    { jsonrpc: '2.0', id: 1, error: null },
    { jsonrpc: '2.0', id: 1, result: DEVNET_GENESIS_HASH, error: { code: -1, message: 'bad' } },
  ])('rejects protocol errors or malformed envelopes %j', async (body) => {
    const report = await checkDevnetPrograms(manifest, endpoint, vi.fn<typeof fetch>().mockResolvedValue(json(body)))
    expect(report.status).toBe('FAIL')
    expect(report.cluster.error?.code).toBe('protocol')
  })

  it.each([null, {}, { context: { slot: 1 } }, { context: { slot: -1 }, value: null },
    { context: { slot: 1.5 }, value: null }, { context: { slot: 1 }, value: {} },
    { context: { slot: 1 }, value: { executable: 'true' } }, { context: { slot: 1 }, value: [] },
  ])('rejects malformed account payloads %j', async (value) => {
    const report = await checkDevnetPrograms(manifest, endpoint, mockRpc(() => value))
    expect(report.status).toBe('FAIL')
    expect(report.programs.every((program) => program.error?.code === 'payload' && program.exists === null)).toBe(true)
  })

  it.each([{ owner: 'invalid' }, { lamports: -1 }, { rentEpoch: null }, { data: ['', 'jsonParsed'] },
    { data: [] }, { data: [42, 'base64'] }, { executable: 1 },
  ])('rejects invalid account metadata %j', async (patch) => {
    const report = await checkDevnetPrograms(manifest, endpoint, mockRpc(() => ({ ...account(), value: { ...account().value, ...patch } })))
    expect(report.programs.every((program) => program.error?.code === 'payload')).toBe(true)
  })

  it.each([429, 500, 503])('reports HTTP %i without trusting the body', async (status) => {
    const report = await checkDevnetPrograms(manifest, endpoint, vi.fn<typeof fetch>().mockResolvedValue(json({}, status)))
    expect(report.cluster.error).toEqual({ code: 'http', message: `RPC HTTP ${status}` })
  })

  it('reports account HTTP failures without invalidating verified cluster identity', async () => {
    const fetchImpl = mockRpc()
    fetchImpl.mockImplementationOnce(async () => json({ jsonrpc: '2.0', id: 1, result: DEVNET_GENESIS_HASH }))
    fetchImpl.mockImplementation(async () => json({}, 503))
    const report = await checkDevnetPrograms(manifest, endpoint, fetchImpl)
    expect(report.cluster.verified).toBe(true)
    expect(report.programs.every((program) => program.error?.code === 'http')).toBe(true)
  })

  it('reports malformed JSON', async () => {
    const report = await checkDevnetPrograms(manifest, endpoint, vi.fn<typeof fetch>().mockResolvedValue(new Response('{')))
    expect(report.cluster.error?.code).toBe('payload')
  })

  it.each([['fetch', new Error('https://provider.invalid/?api-key=secret')], ['abort', new DOMException('aborted', 'AbortError')]])('reports %s failures without exposing provider details', async (code, error) => {
    const report = await checkDevnetPrograms(manifest, endpoint, vi.fn<typeof fetch>().mockRejectedValue(error))
    expect(report.cluster.error?.code).toBe(code)
    expect(JSON.stringify(report)).not.toContain('secret')
  })

  it.each(['fetch', 'body'])('bounds a stalled %s even when abort is ignored', async (stage) => {
    vi.useFakeTimers()
    const stalled = new Promise<never>(() => {})
    const response = json({})
    vi.spyOn(response, 'json').mockReturnValue(stalled)
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => stage === 'fetch' ? stalled : Promise.resolve(response))
    const pending = checkDevnetPrograms(manifest, endpoint, fetchImpl)
    await vi.advanceTimersByTimeAsync(RPC_TIMEOUT_MS)
    expect((await pending).cluster.error?.code).toBe('timeout')
    expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds parallel stalled program requests', async () => {
    vi.useFakeTimers()
    const fetchImpl = mockRpc()
    fetchImpl.mockImplementationOnce(async () => json({ jsonrpc: '2.0', id: 1, result: DEVNET_GENESIS_HASH }))
    fetchImpl.mockImplementation(() => new Promise<never>(() => {}))
    const pending = checkDevnetPrograms(manifest, endpoint, fetchImpl)
    await vi.advanceTimersByTimeAsync(RPC_TIMEOUT_MS)
    expect((await pending).programs.every((program) => program.error?.code === 'timeout')).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['', 'not-a-url', 'file:///manifest.json'])('rejects invalid RPC URL %s', async (url) => {
    const fetchImpl = mockRpc()
    expect((await checkDevnetPrograms(manifest, url, fetchImpl)).cluster.error?.code).toBe('input')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('devnet preflight CLI', () => {
  it.each(['.dev/wallets.json', '.dev/WALLETS.JSON', 'wallets.Json', 'manifest.txt'])('rejects disallowed file %s before any read', async (filename) => {
    const readText = vi.fn()
    const fetchImpl = mockRpc()
    expect(await runDevnetPreflightCli(['--manifest', filename, '--rpc', endpoint], readText, fetchImpl)).toMatchObject({ status: 'FAIL', error: { code: 'input' } })
    expect(readText).not.toHaveBeenCalled()
    expect(realpath).not.toHaveBeenCalled()
    expect(readFile).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it.each(['/repo/.dev/wallets.json', '/repo/.dev/WALLETS.JSON', '/repo/manifest.txt'])('rejects symlink target %s before reading disk', async (resolved) => {
    vi.mocked(realpath).mockResolvedValue(resolved)
    const fetchImpl = mockRpc()
    expect(await runDevnetPreflightCli(['--manifest', 'alias.json', '--rpc', endpoint], undefined, fetchImpl)).toMatchObject({ status: 'FAIL', error: { code: 'input' } })
    expect(realpath).toHaveBeenCalledExactlyOnceWith('alias.json')
    expect(readFile).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it('resolves a public manifest path before the mocked disk read', async () => {
    vi.mocked(realpath).mockResolvedValue('/repo/public.json')
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(manifest))
    expect((await runDevnetPreflightCli(['--manifest', 'alias.json', '--rpc', endpoint], undefined, mockRpc())).status).toBe('PASS')
    expect(readFile).toHaveBeenCalledExactlyOnceWith('/repo/public.json', 'utf8')
  })
  it('reads only the explicit manifest and uses the explicit RPC', async () => {
    const readText = vi.fn().mockResolvedValue(JSON.stringify(manifest))
    const fetchImpl = mockRpc()
    const report = await runDevnetPreflightCli(['--manifest', 'public.json', '--rpc', endpoint], readText, fetchImpl)
    expect(report.status).toBe('PASS')
    expect(readText).toHaveBeenCalledExactlyOnceWith('public.json')
  })
  it.each([[], ['--manifest', 'public.json'], ['--rpc', endpoint], ['--manifest', 'a', '--rpc'],
    ['--manifest', 'a', '--manifest', 'b', '--rpc', endpoint], ['--wallet', 'x', '--rpc', endpoint],
  ].map((args) => ({ args })))('rejects incomplete, duplicate or unsupported arguments $args', async ({ args }) => {
    const readText = vi.fn()
    const fetchImpl = mockRpc()
    expect(await runDevnetPreflightCli(args, readText, fetchImpl)).toMatchObject({ status: 'FAIL', error: { code: 'input' } })
    expect(readText).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it.each(['{', '{}', JSON.stringify({ ...manifest, cluster: 'localnet' })])('rejects malformed or non-devnet manifests without RPC', async (text) => {
    const fetchImpl = mockRpc()
    expect(await runDevnetPreflightCli(['--manifest', 'public.json', '--rpc', endpoint], async () => text, fetchImpl)).toMatchObject({ status: 'FAIL', error: { code: 'input' } })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it('reports an unreadable manifest without RPC', async () => {
    const fetchImpl = mockRpc()
    expect(await runDevnetPreflightCli(['--manifest', 'absent.json', '--rpc', endpoint], async () => { throw new Error('ENOENT') }, fetchImpl)).toMatchObject({ status: 'FAIL', error: { code: 'input' } })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
