import { getAddressDecoder } from '@solana/kit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AVEO_HOOK_PROGRAM_ID, SAS_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '../api/constants'
import { DeploymentError, fetchDeployment, parseDeployment, type Deployment, type DeploymentTarget } from './deployment'

const addr = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n))
const target: DeploymentTarget = { cluster: 'localnet', programId: AVEO_HOOK_PROGRAM_ID }

function manifest(): Deployment {
  return {
    version: 1,
    cluster: 'localnet',
    generatedAt: '2026-10-09T12:00:00.000Z',
    programs: { aveoHook: AVEO_HOOK_PROGRAM_ID, sas: SAS_PROGRAM_ID, token2022: TOKEN_2022_PROGRAM_ID },
    proofDomain: 'ab'.repeat(32),
    issuer: addr(1),
    verifiers: [{ id: 'verifier', label: 'Verifier', authority: addr(2), credential: addr(3), schema: addr(4) }],
    assets: [{ id: 'asset', label: 'Asset', symbol: 'TEST', mint: addr(5), decimals: 6 }],
    wallets: [{ id: 'treasury', label: 'Treasury', address: addr(6), role: 'treasury' }],
  }
}

function expectInvalid(raw: unknown, path: string, expected: DeploymentTarget = target) {
  try {
    parseDeployment(raw, expected)
    expect.fail('Expected an invalid manifest')
  } catch (error) {
    expect(error).toBeInstanceOf(DeploymentError)
    const deploymentError = error as DeploymentError
    expect(deploymentError.kind).toBe('invalid')
    expect(deploymentError.issues.some((issue) => issue.startsWith(`${path}:`))).toBe(true)
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('deployment validation', () => {
  it('preserves a valid local fixture', () => {
    expect(parseDeployment(manifest(), target)).toEqual(manifest())
  })

  it('accepts devnet and an explicitly selected alternate Aveo program', () => {
    const raw = manifest()
    raw.cluster = 'devnet'
    raw.programs.aveoHook = addr(7)
    expect(parseDeployment(raw, { cluster: 'devnet', programId: addr(7) })).toEqual(raw)
  })

  it.each(['localnet', 'devnet'] as const)('rejects a manifest from another network when selecting %s', (cluster) => {
    const raw = manifest()
    raw.cluster = cluster === 'devnet' ? 'localnet' : 'devnet'
    expectInvalid(raw, 'cluster', { ...target, cluster })
  })

  it('rejects a valid but different Aveo program address', () => {
    const raw = manifest()
    raw.programs.aveoHook = addr(7)
    expectInvalid(raw, 'programs.aveoHook')
  })

  it('reports both network and Aveo program mismatches', () => {
    const raw = manifest()
    raw.cluster = 'devnet'
    raw.programs.aveoHook = addr(7)
    expectInvalid(raw, 'cluster')
    expectInvalid(raw, 'programs.aveoHook')
  })

  it.each(['sas', 'token2022'] as const)('rejects an unsupported %s program even without an environment target', (program) => {
    const raw = manifest()
    raw.programs[program] = addr(8)
    expectInvalid(raw, `programs.${program}`)
    expect(() => parseDeployment(raw)).toThrow(DeploymentError)
  })

  it.each([
    ['version', { version: 2 }],
    ['cluster', { cluster: 'mainnet-beta' }],
    ['proofDomain', { proofDomain: 'ab'.repeat(31) }],
    ['proofDomain', { proofDomain: 'zz'.repeat(32) }],
    ['issuer', { issuer: 'invalid-address' }],
    ['programs.aveoHook', { programs: { ...manifest().programs, aveoHook: 'invalid-address' } }],
    ['verifiers', { verifiers: [] }],
    ['assets', { assets: [] }],
    ['wallets', { wallets: [] }],
    ['assets.0.decimals', { assets: [{ ...manifest().assets[0], decimals: 1.5 }] }],
    ['wallets.0.address', { wallets: [{ ...manifest().wallets[0], address: 'invalid-address' }] }],
  ])('rejects malformed %s', (path, override) => {
    expectInvalid({ ...manifest(), ...override }, path)
  })
})

describe('deployment loading', () => {
  function respond(body: unknown, status = 200, contentType = 'application/json') {
    return vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': contentType },
    })))
  }

  it('loads a matching manifest without an HTTP cache', async () => {
    respond(manifest())
    await expect(fetchDeployment('/deployment.json', target)).resolves.toEqual(manifest())
    expect(fetch).toHaveBeenCalledWith('/deployment.json', { cache: 'no-store' })
  })

  it.each(['cluster', 'program'] as const)('rejects a fetched %s mismatch before returning data', async (mismatch) => {
    const raw = manifest()
    if (mismatch === 'cluster') raw.cluster = 'devnet'
    else raw.programs.aveoHook = addr(7)
    respond(raw)
    await expect(fetchDeployment('/deployment.json', target)).rejects.toMatchObject({ kind: 'invalid' })
  })

  it('reports a missing manifest', async () => {
    respond({}, 404)
    await expect(fetchDeployment('/deployment.json', target)).rejects.toMatchObject({ kind: 'not-found' })
  })

  it('detects an SPA HTML fallback', async () => {
    respond('<html></html>', 200, 'text/html')
    await expect(fetchDeployment('/deployment.json', target)).rejects.toMatchObject({ kind: 'not-found' })
  })

  it('reports malformed JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{', { headers: { 'content-type': 'application/json' } })))
    await expect(fetchDeployment('/deployment.json', target)).rejects.toMatchObject({ kind: 'invalid' })
  })

  it('reports HTTP failures', async () => {
    respond({}, 503)
    await expect(fetchDeployment('/deployment.json', target)).rejects.toMatchObject({ kind: 'network' })
  })

  it('reports connection failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Connection failed')))
    await expect(fetchDeployment('/deployment.json', target)).rejects.toMatchObject({ kind: 'network', message: 'Connection failed' })
  })
})
