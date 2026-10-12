import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAddressDecoder } from '@solana/kit'
import { afterEach, describe, expect, it } from 'vitest'
import type { ApiContext } from '../src/api/context'
import { SUBMISSION_INTENT_STORAGE_KEY, SubmissionIntentStore } from '../src/features/operations/submission-intent'
import { createLocalIntentStorage, openLocalIntentStorage } from './local-intent-storage'

const directories: string[] = []
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'aveo-intent-storage-test-'))
  directories.push(directory)
  return { directory, ...createLocalIntentStorage(directory) }
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('private isolated local intent storage', () => {
  it('creates an exclusive private metadata file and reopens the exact record', () => {
    const f = fixture()
    expect(statSync(f.file).mode & 0o777).toBe(0o600)
    expect(f.storage.getItem(SUBMISSION_INTENT_STORAGE_KEY)).toBe('null')
    f.storage.setItem(SUBMISSION_INTENT_STORAGE_KEY, '{"public":"metadata"}')
    expect(openLocalIntentStorage(f.file).getItem(SUBMISSION_INTENT_STORAGE_KEY)).toBe('{"public":"metadata"}')
  })

  it('persists the signatureless blocker across a genuine child-process restart', async () => {
    const f = fixture()
    const wallet = getAddressDecoder().decode(new Uint8Array(32).fill(7))
    const ctx = { cluster: 'localnet', rpcUrl: 'http://127.0.0.1:8899', programId: wallet, commitment: 'confirmed', deployment: { generatedAt: '2026-10-11T00:00:00Z' } } as ApiContext
    const store = new SubmissionIntentStore(f.storage, async (operation) => { await operation() })
    const attempt = await store.reserve(ctx, wallet, 'transfer')
    await store.startWallet(attempt, 'a'.repeat(64))
    const before = readFileSync(f.file, 'utf8')
    const adapterUrl = new URL('./local-intent-storage.ts', import.meta.url).href
    const storeUrl = new URL('../src/features/operations/submission-intent.ts', import.meta.url).href
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
      import { openLocalIntentStorage } from ${JSON.stringify(adapterUrl)};
      import { SubmissionIntentStore } from ${JSON.stringify(storeUrl)};
      const store = new SubmissionIntentStore(openLocalIntentStorage(${JSON.stringify(f.file)}), async operation => { await operation(); });
      const intent = store.getSnapshot().intent;
      let blocked = false;
      try { await store.reserve(${JSON.stringify(ctx)}, ${JSON.stringify(wallet)}, 'transfer'); } catch { blocked = true; }
      console.log(JSON.stringify({ blocked, phase: intent?.phase, signature: intent?.signature, attemptId: intent?.attemptId }));
    `], { cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), encoding: 'utf8', timeout: 10_000 })
    expect(JSON.parse(output)).toEqual({ blocked: true, phase: 'wallet-invoked', attemptId: attempt.attemptId })
    expect(readFileSync(f.file, 'utf8')).toBe(before)
  })

  it.each(['get', 'set'] as const)('rejects unrelated storage keys on %s', (operation) => {
    const f = fixture()
    expect(() => operation === 'get' ? f.storage.getItem('private-key') : f.storage.setItem('private-key', 'x')).toThrow('unavailable')
    expect(readFileSync(f.file, 'utf8')).toBe('null')
  })

  it('rejects oversized writes before altering the existing record', () => {
    const f = fixture()
    expect(() => f.storage.setItem(SUBMISSION_INTENT_STORAGE_KEY, 'x'.repeat(2049))).toThrow('unavailable')
    expect(readFileSync(f.file, 'utf8')).toBe('null')
    expect(() => f.storage.setItem(SUBMISSION_INTENT_STORAGE_KEY, 'á'.repeat(1025))).toThrow('unavailable')
  })

  it('rejects oversized files without reading them', () => {
    const f = fixture()
    writeFileSync(f.file, 'x'.repeat(2049))
    expect(() => f.storage.getItem(SUBMISSION_INTENT_STORAGE_KEY)).toThrow('unavailable')
  })

  it.each(['symlink', 'inode', 'permissions'] as const)('does not overwrite a %s replacement', (mode) => {
    const f = fixture()
    const original = path.join(f.directory, 'original.json')
    if (mode === 'permissions') chmodSync(f.file, 0o644)
    else {
      renameSync(f.file, original)
      if (mode === 'symlink') symlinkSync(original, f.file)
      else writeFileSync(f.file, 'replacement', { mode: 0o600 })
    }
    expect(() => f.storage.setItem(SUBMISSION_INTENT_STORAGE_KEY, 'null')).toThrow('unavailable')
    expect(readFileSync(f.file, 'utf8')).toBe(mode === 'inode' ? 'replacement' : 'null')
  })

  it('rejects a symlink directory, nonprivate directory and nonintent filename', () => {
    const f = fixture()
    const alias = path.join(f.directory, 'alias')
    symlinkSync(f.directory, alias)
    expect(() => createLocalIntentStorage(alias)).toThrow('unavailable')
    expect(() => openLocalIntentStorage(path.join(f.directory, 'wallets.json'))).toThrow('unavailable')
    chmodSync(f.directory, 0o755)
    expect(() => createLocalIntentStorage(f.directory)).toThrow('unavailable')
  })
})
