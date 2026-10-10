import { getAddressDecoder } from '@solana/kit'
import { readFileSync, realpathSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AVEO_HOOK_PROGRAM_ID, SAS_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '../src/api/constants'
import { publicRelease } from './public-release'

vi.mock('node:fs', () => ({ readFileSync: vi.fn(), realpathSync: vi.fn((filename: string) => filename) }))
afterEach(() => vi.resetAllMocks())

function manifest() {
  const addr = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n))
  return {
    version: 1, cluster: 'devnet', generatedAt: '2026-10-10T12:00:00.000Z',
    programs: { aveoHook: AVEO_HOOK_PROGRAM_ID, sas: SAS_PROGRAM_ID, token2022: TOKEN_2022_PROGRAM_ID },
    proofDomain: 'ab'.repeat(32), issuer: addr(1),
    verifiers: [{ id: 'verifier', label: 'Verifier', authority: addr(2), credential: addr(3), schema: addr(4) }],
    assets: [{ id: 'asset', label: 'Asset', symbol: 'TEST', mint: addr(5), decimals: 6 }],
    wallets: [{ id: 'treasury', label: 'Treasury', address: addr(6), role: 'treasury' }],
  }
}

const env = {
  AVEO_PUBLIC_RELEASE: 'true',
  VITE_CLUSTER: 'devnet',
  VITE_ENABLE_DEV_WALLETS: 'false',
  VITE_BACKEND: 'aveo-sas-hook',
  VITE_COMMITMENT: 'confirmed',
  VITE_DEPLOYMENT_URL: '/deployment.json',
  VITE_RPC_URL: 'https://api.devnet.solana.com',
}

function run(overrides: Record<string, string | undefined> = {}, emitFile: (asset: unknown) => unknown = () => { throw new Error('Unexpected emission') }) {
  const plugin = publicRelease({ ...env, ...overrides }, process.cwd())
  const hook = plugin.buildStart
  if (typeof hook !== 'function') throw new Error('Expected buildStart function')
  return hook.call({ emitFile } as never, {} as never)
}

describe('public release gates', () => {
  it('leaves ordinary builds unchanged', () => {
    expect(run({ AVEO_PUBLIC_RELEASE: undefined })).toBeUndefined()
  })
  it.each([
    ['VITE_CLUSTER', 'localnet', 'VITE_CLUSTER'],
    ['VITE_ENABLE_DEV_WALLETS', 'true', 'synthetic wallets'],
    ['VITE_ENABLE_DEV_WALLETS', undefined, 'synthetic wallets'],
    ['VITE_BACKEND', 'mpl-3643', 'implemented Aveo backend'],
    ['VITE_COMMITMENT', 'processed', 'commitment'],
    ['VITE_DEPLOYMENT_URL', '/dev/deployment.json', 'VITE_DEPLOYMENT_URL'],
    ['VITE_RPC_URL', 'http://127.0.0.1:8899', 'HTTPS RPC'],
    ['VITE_RPC_URL', 'https://user:secret@example.com', 'HTTPS RPC'],
    ['VITE_RPC_URL', 'https://example.com?api-key=secret', 'HTTPS RPC'],
  ])('rejects unsafe %s=%s', (key, value, message) => {
    expect(() => run({ [key]: value })).toThrow(message)
  })
  it('requires an explicitly selected public manifest', () => {
    expect(() => run()).toThrow('AVEO_PUBLIC_MANIFEST')
  })
  it('emits only the validated public manifest at the runtime URL', () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(manifest()))
    const emit = vi.fn()
    run({ AVEO_PUBLIC_MANIFEST: '/approved/deployment.json', VITE_AVEO_PROGRAM_ID: AVEO_HOOK_PROGRAM_ID }, emit)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith({ type: 'asset', fileName: 'deployment.json', source: expect.any(String) })
    expect(JSON.parse(emit.mock.calls[0]![0].source)).toEqual(manifest())
    expect(readFileSync).toHaveBeenCalledWith('/approved/deployment.json', 'utf8')
  })
  it('rejects mismatching program identity without emitting an asset', () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(manifest()))
    const emit = vi.fn()
    expect(() => run({ AVEO_PUBLIC_MANIFEST: '/approved/deployment.json', VITE_AVEO_PROGRAM_ID: undefined }, emit)).toThrow('program ID')
    expect(emit).not.toHaveBeenCalled()
  })
  it('does not publish local fixtures relabeled only by environment', () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ ...manifest(), cluster: 'localnet' }))
    const emit = vi.fn()
    expect(() => run({ AVEO_PUBLIC_MANIFEST: '/approved/deployment.json', VITE_AVEO_PROGRAM_ID: AVEO_HOOK_PROGRAM_ID }, emit)).toThrow()
    expect(emit).not.toHaveBeenCalled()
  })
  it('refuses a wallet key filename without reading it', () => {
    expect(() => run({ AVEO_PUBLIC_MANIFEST: '.dev/wallets.json' })).toThrow('Wallet key files')
    expect(readFileSync).not.toHaveBeenCalled()
  })
  it('keeps untrusted manifest contents out of build errors', () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ secretKey: 'must-not-appear' }))
    expect(() => run({ AVEO_PUBLIC_MANIFEST: '/approved/deployment.json' })).toThrow('valid public devnet JSON')
    try { run({ AVEO_PUBLIC_MANIFEST: '/approved/deployment.json' }) } catch (error) {
      expect(String(error)).not.toContain('must-not-appear')
    }
  })
  it('refuses a symlink to wallet keys before reading contents', () => {
    vi.mocked(realpathSync).mockReturnValue('/private/.dev/wallets.json')
    expect(() => run({ AVEO_PUBLIC_MANIFEST: '/approved/deployment.json' })).toThrow('valid public devnet JSON')
    expect(readFileSync).not.toHaveBeenCalled()
  })
})
