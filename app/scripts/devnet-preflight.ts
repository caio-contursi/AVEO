import { isAddress } from '@solana/kit'
import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDeployment, type Deployment } from '../src/config/deployment'

// Full genesis hash, not the truncated CAIP-2 chain identifier:
// https://github.com/solana-labs/solana/blob/master/sdk/src/genesis_config.rs
export const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
export const RPC_TIMEOUT_MS = 10_000
const MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
const TESTNET_GENESIS_HASH = '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY'

type IssueCode = 'input' | 'wrong-cluster' | 'http' | 'fetch' | 'abort' | 'timeout' | 'protocol' | 'payload' | 'missing-program' | 'non-executable'
export interface PreflightIssue { code: IssueCode; message: string }
export interface ProgramPreflight {
  name: keyof Deployment['programs']
  address: string
  status: 'PASS' | 'FAIL' | 'NOT_RUN'
  exists: boolean | null
  executable: boolean | null
  slot: number | null
  error: PreflightIssue | null
}
export interface DevnetProgramReport {
  scope: 'devnet-program-preflight'
  status: 'PASS' | 'FAIL'
  cluster: {
    expected: 'devnet'
    manifest: Deployment['cluster']
    observed: 'devnet' | 'mainnet-beta' | 'testnet' | 'unknown' | null
    expectedGenesisHash: string
    genesisHash: string | null
    verified: boolean
    error: PreflightIssue | null
  }
  programs: ProgramPreflight[]
}

class RpcFailure extends Error {
  constructor(readonly code: IssueCode, message: string) { super(message) }
}
function issue(error: unknown): PreflightIssue {
  if (error instanceof RpcFailure) return { code: error.code, message: error.message }
  // Do not echo provider errors, which can include RPC credentials.
  return { code: error instanceof Error && error.name === 'AbortError' ? 'abort' : 'fetch', message: 'RPC request could not complete' }
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function rpc(rpcUrl: string, method: string, params: unknown[], id: number, fetchImpl: typeof fetch): Promise<unknown> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new RpcFailure('timeout', `RPC request exceeded ${RPC_TIMEOUT_MS} ms`))
      controller.abort()
    }, RPC_TIMEOUT_MS)
  })
  try {
    // The deadline includes body consumption and still bounds a fetch mock that ignores abort.
    return await Promise.race([timeout, (async () => {
      const response = await fetchImpl(rpcUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: controller.signal,
      })
      if (!response.ok) throw new RpcFailure('http', `RPC HTTP ${response.status}`)
      let body: unknown
      try { body = await response.json() } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error
        throw new RpcFailure('payload', 'RPC response is not valid JSON')
      }
      if (!object(body) || body.jsonrpc !== '2.0' || body.id !== id) {
        throw new RpcFailure('protocol', 'RPC response has an invalid envelope or request ID')
      }
      if ('error' in body) {
        if ('result' in body || !object(body.error) || !Number.isInteger(body.error.code) || typeof body.error.message !== 'string') {
          throw new RpcFailure('protocol', 'RPC error envelope is malformed')
        }
        throw new RpcFailure('protocol', `RPC returned error ${body.error.code}`)
      }
      if (!('result' in body)) throw new RpcFailure('protocol', 'RPC response has no result')
      return body.result
    })()])
  } finally { clearTimeout(timer) }
}

/** Checks only network identity and deployment program presence/executability. */
export async function checkDevnetPrograms(manifest: Deployment, rpcUrl: string, fetchImpl = fetch): Promise<DevnetProgramReport> {
  const report: DevnetProgramReport = {
    scope: 'devnet-program-preflight', status: 'FAIL',
    cluster: { expected: 'devnet', manifest: manifest.cluster, observed: null,
      expectedGenesisHash: DEVNET_GENESIS_HASH, genesisHash: null, verified: false, error: null },
    programs: (Object.keys(manifest.programs) as (keyof Deployment['programs'])[]).map((name) => ({
      name, address: manifest.programs[name], status: 'NOT_RUN', exists: null, executable: null, slot: null, error: null,
    })),
  }
  try {
    if (manifest.cluster !== 'devnet') throw new RpcFailure('wrong-cluster', 'Manifest must target devnet')
    let endpoint: URL
    try { endpoint = new URL(rpcUrl) } catch { throw new RpcFailure('input', 'RPC URL must be an absolute HTTP(S) URL') }
    if (!['http:', 'https:'].includes(endpoint.protocol)) throw new RpcFailure('input', 'RPC URL must use HTTP(S)')
    const genesis = await rpc(rpcUrl, 'getGenesisHash', [], 1, fetchImpl)
    if (typeof genesis !== 'string' || !isAddress(genesis)) throw new RpcFailure('payload', 'RPC genesis hash must encode 32 bytes in base58')
    report.cluster.genesisHash = genesis
    report.cluster.observed = genesis === DEVNET_GENESIS_HASH ? 'devnet'
      : genesis === MAINNET_GENESIS_HASH ? 'mainnet-beta' : genesis === TESTNET_GENESIS_HASH ? 'testnet' : 'unknown'
    if (genesis !== DEVNET_GENESIS_HASH) throw new RpcFailure('wrong-cluster', 'RPC genesis hash does not match devnet')
    report.cluster.verified = true
  } catch (error) { report.cluster.error = issue(error); return report }

  await Promise.all(report.programs.map(async (program, index) => {
    try {
      const result = await rpc(rpcUrl, 'getAccountInfo', [program.address, {
        encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 0, length: 0 },
      }], index + 2, fetchImpl)
      if (!object(result) || !object(result.context) || !Number.isSafeInteger(result.context.slot) || (result.context.slot as number) < 0 || !('value' in result)) {
        throw new RpcFailure('payload', 'RPC account result has an invalid context or missing value')
      }
      program.slot = result.context.slot as number
      if (result.value === null) {
        program.exists = false
        throw new RpcFailure('missing-program', 'Program account is absent on devnet')
      }
      const value = result.value
      if (!object(value) || typeof value.executable !== 'boolean' || typeof value.owner !== 'string' || !isAddress(value.owner) ||
        !Number.isInteger(value.lamports) || (value.lamports as number) < 0 ||
        !Number.isInteger(value.rentEpoch) || (value.rentEpoch as number) < 0 ||
        !Array.isArray(value.data) || value.data.length !== 2 || typeof value.data[0] !== 'string' || value.data[1] !== 'base64') {
        throw new RpcFailure('payload', 'RPC account value has invalid metadata or encoding')
      }
      program.exists = true
      program.executable = value.executable
      if (!program.executable) throw new RpcFailure('non-executable', 'Account exists but is not executable')
      program.status = 'PASS'
    } catch (error) { program.status = 'FAIL'; program.error = issue(error) }
  }))
  report.status = report.programs.length === 3 && report.programs.every((program) => program.status === 'PASS') ? 'PASS' : 'FAIL'
  return report
}

function validateManifestFilename(filename: string): void {
  const basename = path.basename(filename).toLowerCase()
  if (basename === 'wallets.json' || !basename.endsWith('.json')) {
    throw new Error('Manifest must be a JSON file other than wallets.json')
  }
}

async function readManifestText(filename: string): Promise<string> {
  const resolved = await realpath(filename)
  validateManifestFilename(resolved)
  return readFile(resolved, 'utf8')
}

export async function runDevnetPreflightCli(
  args: string[],
  readText: (filename: string) => Promise<string> = readManifestText,
  fetchImpl = fetch,
): Promise<DevnetProgramReport | { scope: 'devnet-program-preflight'; status: 'FAIL'; error: PreflightIssue }> {
  try {
    const options = new Map<string, string>()
    for (let index = 0; index < args.length; index += 2) {
      const flag = args[index]
      const value = args[index + 1]
      if (!['--manifest', '--rpc'].includes(flag) || !value || value.startsWith('--') || options.has(flag)) {
        throw new Error('Invalid arguments')
      }
      options.set(flag, value)
    }
    const filename = options.get('--manifest')
    const endpoint = options.get('--rpc')
    if (!filename || !endpoint) throw new Error('Missing arguments')
    validateManifestFilename(filename)
    const { parsePublicManifest } = await import('./public-manifest')
    const publicManifest = parsePublicManifest(JSON.parse(await readText(filename)))
    const manifest = parseDeployment(publicManifest, { cluster: 'devnet', programId: publicManifest.programs.aveoHook })
    return await checkDevnetPrograms(manifest, endpoint, fetchImpl)
  } catch {
    return { scope: 'devnet-program-preflight', status: 'FAIL', error: {
      code: 'input', message: 'Supply --manifest <public devnet manifest.json> and --rpc <HTTP(S) URL>; manifest must be readable, valid public deployment JSON for devnet',
    } }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runDevnetPreflightCli(process.argv.slice(2)).then((report) => {
    console.log(JSON.stringify(report, null, 2))
    process.exitCode = report.status === 'PASS' ? 0 : 1
  })
}
