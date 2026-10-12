import { getAddressDecoder } from '@solana/kit'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, link, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AVEO_HOOK_PROGRAM_ID, SAS_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '../src/api/constants'
import { DeploymentError, type Deployment } from '../src/config/deployment'
import { parsePublicManifest, runPublicManifestCli, serializePublicManifest } from './public-manifest'

const addr = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n))
function manifest(): Deployment {
  return {
    version: 1, cluster: 'devnet', generatedAt: '2026-10-09T12:00:00.000Z',
    programs: { aveoHook: AVEO_HOOK_PROGRAM_ID, sas: SAS_PROGRAM_ID, token2022: TOKEN_2022_PROGRAM_ID },
    proofDomain: 'ab'.repeat(32), issuer: addr(1),
    verifiers: [{ id: 'v', label: 'Verifier', authority: addr(2), credential: addr(3), schema: addr(4) }],
    assets: [{ id: 'a', label: 'Asset', symbol: 'TEST', mint: addr(5), decimals: 6 }],
    wallets: [{ id: 'w', label: 'Treasury', address: addr(6), role: 'treasury' }],
  }
}

describe('public manifest validation and serialization', () => {
  it('preserves valid public configuration and produces stable JSON with a trailing newline', () => {
    expect(parsePublicManifest(manifest())).toEqual(manifest())
    expect(serializePublicManifest(manifest())).toBe(`${JSON.stringify(manifest(), null, 2)}\n`)
  })

  it('strips unknown fields at every schema level without changing the source', () => {
    const raw = {
      ...manifest(), metadata: { internal: 'discard' },
      programs: { ...manifest().programs, endpoint: 'discard' },
      assets: [{ ...manifest().assets[0], metadata: 'discard' }],
      wallets: [{ ...manifest().wallets[0], balance: 10 }],
      verifiers: [{ ...manifest().verifiers[0], enabled: true }],
    }
    expect(JSON.parse(serializePublicManifest(raw))).toEqual(manifest())
    expect(raw.metadata).toEqual({ internal: 'discard' })
  })

  it.each(['localnet', 'mainnet-beta', '', null])('rejects non-devnet cluster %s', (cluster) => {
    expect(() => parsePublicManifest({ ...manifest(), cluster })).toThrow(DeploymentError)
  })

  it.each(['', 'yesterday', '2026-02-30T12:00:00Z', '2025-02-29T12:00:00Z',
    '2026-10-09', '2026-10-09T12:00:00', '2026-10-09T25:00:00Z', '2026-10-09T12:00:00+25:00'])(
  'rejects invalid or timezone-free timestamp %s', (generatedAt) => {
    expect(() => parsePublicManifest({ ...manifest(), generatedAt })).toThrow(DeploymentError)
  })

  it.each(['2024-02-29T12:00:00Z', '2026-10-09T12:00:00.123456Z', '2026-10-09T12:00:00-03:00'])(
  'accepts valid ISO timestamp %s', (generatedAt) => {
    expect(parsePublicManifest({ ...manifest(), generatedAt }).generatedAt).toBe(generatedAt)
  })

  it.each(['sas', 'token2022'] as const)('enforces the existing supported %s ID', (program) => {
    expect(() => parsePublicManifest({ ...manifest(), programs: { ...manifest().programs, [program]: addr(9) } })).toThrow(DeploymentError)
  })

  it.each([null, [], '{', {}, { version: 2 }, { issuer: 'invalid' }, { proofDomain: 'ff' },
    { programs: {} }, { generatedAt: 42 }, { assets: [] }, { wallets: [] }, { verifiers: [] },
    { assets: [{ ...manifest().assets[0], decimals: -1 }] },
    { assets: [{ ...manifest().assets[0], decimals: 1.2 }] },
    { assets: [{ ...manifest().assets[0], decimals: 10 }] },
    { assets: [{ ...manifest().assets[0], mint: 'invalid' }] },
    { wallets: [{ ...manifest().wallets[0], role: 'admin' }] },
    { verifiers: [{ ...manifest().verifiers[0], authority: 'invalid' }] },
  ])('rejects malformed configuration %#', (patch) => {
    const raw = patch && typeof patch === 'object' && !Array.isArray(patch) && Object.keys(patch).length
      ? { ...manifest(), ...patch } : patch
    expect(() => parsePublicManifest(raw)).toThrow(DeploymentError)
  })

  it.each(['secretKey', 'private_key', 'keypair', 'seedPhrase', 'mnemonic', 'password', 'passphrase', 'api-key', 'accessToken'])(
  'rejects secret-like field %s recursively, even in discarded metadata', (field) => {
    const raw = { ...manifest(), metadata: [{ nested: { [field]: 'do-not-log' } }] }
    expect(() => serializePublicManifest(raw)).toThrow(DeploymentError)
    try { parsePublicManifest(raw) } catch (error) {
      expect((error as DeploymentError).issues).toEqual(['secret-like fields are forbidden'])
    }
    try { parsePublicManifest(raw) } catch (error) { expect(String(error)).not.toContain('do-not-log') }
  })

  it.each(['-----BEGIN PRIVATE KEY-----', 'https://user:password@example.com', 'https://example.com/?api_key=private'])(
  'rejects obvious secret material in an allowed string %#', (label) => {
    expect(() => serializePublicManifest({ ...manifest(), wallets: [{ ...manifest().wallets[0], label }] })).toThrow(DeploymentError)
  })

  it('rejects cyclic metadata without recursing forever', () => {
    const raw = { ...manifest(), metadata: {} }
    raw.metadata = raw
    expect(() => parsePublicManifest(raw)).toThrow(DeploymentError)
    try { parsePublicManifest(raw) } catch (error) {
      expect((error as DeploymentError).issues).toEqual(['cyclic input is forbidden'])
    }
  })

  it.each(['assets', 'wallets', 'verifiers'] as const)('rejects duplicate %s IDs', (collection) => {
    const raw = manifest()
    expect(() => parsePublicManifest({ ...raw, [collection]: [...raw[collection], { ...raw[collection][0] }] })).toThrow(DeploymentError)
  })

  it.each(['assets', 'wallets'] as const)('rejects duplicate %s addresses with distinct IDs', (collection) => {
    const raw = manifest()
    expect(() => parsePublicManifest({ ...raw, [collection]: [...raw[collection], { ...raw[collection][0], id: 'other' }] })).toThrow(DeploymentError)
  })

  it('rejects repeated verifier records but allows shared authorities for different schemas and shared issuer roles', () => {
    const raw = manifest()
    raw.verifiers.push({ ...raw.verifiers[0], id: 'other' })
    expect(() => parsePublicManifest(raw)).toThrow(DeploymentError)
    raw.verifiers[1].schema = addr(8)
    raw.issuer = raw.verifiers[0].authority
    raw.wallets[0].address = raw.issuer
    expect(parsePublicManifest(raw)).toEqual(raw)
  })
})

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aveo-public-manifest-'))
  directories.push(directory)
  const input = path.join(directory, 'input.json'), output = path.join(directory, 'deployment.json')
  await writeFile(input, JSON.stringify(manifest()))
  return { directory, input, output, args: ['--input', input, '--output', output] }
}

describe('explicit public export CLI', () => {
  it('reads the supplied manifest and creates only the requested public JSON', async () => {
    const { directory, input, output, args } = await fixture()
    await mkdir(path.join(directory, '.dev'))
    await writeFile(path.join(directory, '.dev', 'wallets.json'), 'not JSON; must never be read')
    await runPublicManifestCli(args)
    expect(await readFile(output, 'utf8')).toBe(serializePublicManifest(manifest()))
    expect(await readFile(input, 'utf8')).toBe(JSON.stringify(manifest()))
    expect((await readdir(directory)).sort()).toEqual(['.dev', 'deployment.json', 'input.json'])
  })

  it.each([[], ['--input', 'x'], ['--output', 'x'], ['--input'], ['--help'],
    ['--input', 'x', '--input', 'y'], ['--input', '--output', 'x'], ['--input', 'x', '--output', 'y', 'extra']].map((args) => ({ args })))(
  'rejects incomplete, duplicate and unknown arguments %#', async ({ args }) => {
    await expect(runPublicManifestCli(args)).rejects.toThrow()
  })

  it.each(['directory', 'output.txt', 'wallets.json', '.env'])('rejects broad or unsuitable output %s', async (name) => {
    const { directory, input } = await fixture()
    await expect(runPublicManifestCli(['--input', input, '--output', path.join(directory, name)])).rejects.toThrow()
  })

  it('never overwrites the input or an existing output', async () => {
    const { input, output, args } = await fixture()
    await expect(runPublicManifestCli(['--input', input, '--output', input])).rejects.toThrow('differ')
    await writeFile(output, 'keep')
    await expect(runPublicManifestCli(args)).rejects.toThrow()
    expect(await readFile(output, 'utf8')).toBe('keep')
    expect(await readFile(input, 'utf8')).toBe(JSON.stringify(manifest()))
  })

  it.each(['symlink', 'hardlink'] as const)('refuses output %s aliases to the input', async (kind) => {
    const { input, output, args } = await fixture()
    await (kind === 'symlink' ? symlink(input, output) : link(input, output))
    await expect(runPublicManifestCli(args)).rejects.toThrow()
    expect(await readFile(input, 'utf8')).toBe(JSON.stringify(manifest()))
  })

  it('refuses .dev/wallets.json even via an input symlink', async () => {
    const { directory, input, output } = await fixture()
    await mkdir(path.join(directory, '.dev'))
    const wallets = path.join(directory, '.dev', 'wallets.json')
    await writeFile(wallets, JSON.stringify(manifest()))
    await expect(runPublicManifestCli(['--input', wallets, '--output', output])).rejects.toThrow('forbidden')
    const alias = path.join(directory, 'alias.json')
    await symlink(wallets, alias)
    await expect(runPublicManifestCli(['--input', alias, '--output', output])).rejects.toThrow('forbidden')
    expect(await readFile(input, 'utf8')).toBe(JSON.stringify(manifest()))
  })

  it.each(['.dev', '.git', 'node_modules'])('rejects outputs inside %s including parent symlinks', async (name) => {
    const { directory, input } = await fixture()
    const reserved = path.join(directory, name), alias = path.join(directory, 'alias')
    await mkdir(reserved)
    await symlink(reserved, alias)
    await expect(runPublicManifestCli(['--input', input, '--output', path.join(alias, 'deployment.json')])).rejects.toThrow('reserved')
  })

  it.each(['{', JSON.stringify({ ...manifest(), cluster: 'localnet' }),
    JSON.stringify({ ...manifest(), secretKey: [1, 2, 3] })])('creates no output for unsafe or malformed input %#', async (content) => {
    const { directory, input, args } = await fixture()
    await writeFile(input, content)
    await expect(runPublicManifestCli(args)).rejects.toThrow()
    expect(await readdir(directory)).toEqual(['input.json'])
  })

  it('requires an existing output parent and regular input file', async () => {
    const { directory, input, output } = await fixture()
    await expect(runPublicManifestCli(['--input', input, '--output', path.join(directory, 'missing', 'deployment.json')])).rejects.toThrow()
    await expect(runPublicManifestCli(['--input', directory, '--output', output])).rejects.toThrow('regular')
  })
})
