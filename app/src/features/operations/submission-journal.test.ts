import { getAddressDecoder, getBase58Decoder } from '@solana/kit'
import { describe, expect, it, vi } from 'vitest'
import type { ApiContext } from '../../api/context'
import { SubmissionJournal } from './submission-journal'

const programId = getAddressDecoder().decode(new Uint8Array(32).fill(7))
const signature = (n = 1) => getBase58Decoder().decode(new Uint8Array(64).fill(n))
const ctx = {
  cluster: 'localnet', commitment: 'confirmed', programId,
  rpcUrl: 'https://user:password@rpc.invalid/?apiKey=private-token',
  deployment: { generatedAt: '2026-10-09T12:00:00.000Z' },
} as ApiContext

function storage() {
  let text: string | null = null
  return { getItem: vi.fn(() => text), setItem: vi.fn((_key: string, next: string) => { text = next }), raw: () => text }
}

describe('public signature journal', () => {
  it('survives reopening without storing RPC URLs, keys, plans, logs or cached confirmation', async () => {
    const disk = storage()
    const journal = new SubmissionJournal(disk)
    await journal.capture(ctx, signature())
    const raw = disk.raw()!
    for (const privateField of ['password', 'private-token', 'rpc.invalid', 'rpcUrl', 'secretKey', 'transaction', 'plan', 'logs', 'confirmedStatus']) expect(raw).not.toContain(privateField)
    const loaded = new SubmissionJournal(disk)
    expect(loaded.getSnapshot()).toHaveLength(1)
    expect(await loaded.matches(ctx, loaded.getSnapshot()[0]!)).toBe(true)
    expect(loaded.getSnapshot()[0]).toMatchObject({ version: 1, signature: signature(), programId })
  })

  it('deduplicates sequential and concurrent captures while preserving the first receipt', async () => {
    const disk = storage(), journal = new SubmissionJournal(disk)
    await Promise.all([journal.capture(ctx, signature()), journal.capture(ctx, signature())])
    const original = journal.getSnapshot()[0]
    await journal.capture(ctx, signature())
    expect(journal.getSnapshot()).toHaveLength(1)
    expect(journal.getSnapshot()[0]).toBe(original)
    expect(disk.setItem).toHaveBeenCalledTimes(1)
  })

  it.each([
    { cluster: 'devnet' }, { commitment: 'finalized' }, { programId: getAddressDecoder().decode(new Uint8Array(32).fill(8)) },
    { rpcUrl: 'https://different-rpc.invalid' }, { deployment: { generatedAt: '2026-10-09T13:00:00.000Z' } },
  ])('refuses to match a different scope %j', async (patch) => {
    const journal = new SubmissionJournal(storage())
    await journal.capture(ctx, signature())
    expect(await journal.matches({ ...ctx, ...patch } as ApiContext, journal.getSnapshot()[0]!)).toBe(false)
  })

  it('never overwrites a signature with a different context', async () => {
    const journal = new SubmissionJournal(storage())
    await journal.capture(ctx, signature())
    await expect(journal.capture({ ...ctx, rpcUrl: 'https://other.invalid' }, signature())).rejects.toThrow('another context')
    expect(journal.getSnapshot()).toHaveLength(1)
    expect(await journal.matches(ctx, journal.getSnapshot()[0]!)).toBe(true)
  })

  it('keeps failed writes in memory and reports loss of reload recovery', async () => {
    const disk = storage(), journal = new SubmissionJournal(disk), listener = vi.fn()
    journal.subscribe(listener)
    disk.setItem.mockImplementation(() => { throw new Error('quota exceeded with secret endpoint') })
    await expect(journal.capture(ctx, signature())).rejects.toThrow('only in this session')
    expect(journal.error).toBe('storage-unavailable')
    expect(journal.getSnapshot()).toHaveLength(1)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(new SubmissionJournal(disk).getSnapshot()).toHaveLength(0)
  })

  it('supports a browser where storage access is unavailable', async () => {
    const journal = new SubmissionJournal()
    expect(journal.error).toBe('storage-unavailable')
    await expect(journal.capture(ctx, signature())).rejects.toThrow('only in this session')
    expect(journal.getSnapshot()).toHaveLength(1)
  })

  it('does not silently evict existing receipts at the capacity limit', async () => {
    const disk = storage(), journal = new SubmissionJournal(disk)
    for (let n = 1; n <= 100; n++) await journal.capture(ctx, signature(n))
    const before = disk.raw()
    await expect(journal.capture(ctx, signature(101))).rejects.toThrow('full')
    expect(journal.error).toBe('storage-full')
    expect(journal.getSnapshot()).toHaveLength(100)
    expect(disk.raw()).toBe(before)
  })

  it.each(['{', '{}', '[{"signature":"bad"}]', 'x'.repeat(128_001)])('fails safely on invalid stored data', (raw) => {
    const journal = new SubmissionJournal({ getItem: () => raw, setItem: () => {} })
    expect(journal.error).toBe('invalid-records')
    expect(journal.getSnapshot()).toHaveLength(0)
  })

  it('strips unapproved stored fields and rejects malformed scope data', async () => {
    const disk = storage(), journal = new SubmissionJournal(disk)
    await journal.capture(ctx, signature())
    const record = { ...journal.getSnapshot()[0], secretKey: [1, 2, 3], logs: ['untrusted'], status: 'confirmed' }
    const reopened = new SubmissionJournal({ getItem: () => JSON.stringify([record]), setItem: () => {} })
    expect(reopened.getSnapshot()[0]).not.toHaveProperty('secretKey')
    expect(reopened.getSnapshot()[0]).not.toHaveProperty('status')
    expect(await reopened.matches(ctx, { ...record, rpcFingerprint: 'invalid' })).toBe(false)
  })

  it('rejects duplicate stored signatures', async () => {
    const journal = new SubmissionJournal(storage())
    await journal.capture(ctx, signature())
    const entry = journal.getSnapshot()[0]
    const loaded = new SubmissionJournal({ getItem: () => JSON.stringify([entry, entry]), setItem: () => {} })
    expect(loaded.error).toBe('invalid-records')
    expect(loaded.getSnapshot()).toHaveLength(0)
  })

  it('keeps snapshot identity stable until change and unsubscribes listeners', async () => {
    const journal = new SubmissionJournal(storage()), listener = vi.fn()
    const initial = journal.getSnapshot()
    expect(journal.getSnapshot()).toBe(initial)
    const unsubscribe = journal.subscribe(listener)
    await journal.capture(ctx, signature())
    expect(journal.getSnapshot()).not.toBe(initial)
    expect(Object.isFrozen(journal.getSnapshot())).toBe(true)
    expect(Object.isFrozen(journal.getSnapshot()[0])).toBe(true)
    unsubscribe()
    await journal.capture(ctx, signature(2))
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid signature or deployment timestamp without writing', async () => {
    const disk = storage(), journal = new SubmissionJournal(disk)
    await expect(journal.capture(ctx, 'bad-signature')).rejects.toThrow('public submission receipt')
    await expect(journal.capture({ ...ctx, deployment: { ...ctx.deployment, generatedAt: 'secret-url' } }, signature())).rejects.toThrow('public submission receipt')
    expect(disk.setItem).not.toHaveBeenCalled()
  })
})
