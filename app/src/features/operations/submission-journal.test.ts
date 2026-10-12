import { getAddressDecoder, getBase58Decoder } from '@solana/kit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiContext } from '../../api/context'
import { SubmissionJournal, type JournalCoordinationLock } from './submission-journal'

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

function coordination() {
  let tail = Promise.resolve()
  let active = 0
  let maximum = 0
  const lock: JournalCoordinationLock = (operation) => {
    const result = tail.then(async () => {
      active++
      maximum = Math.max(maximum, active)
      try { await operation() } finally { active-- }
    })
    tail = result.catch(() => {})
    return result
  }
  return { lock, maximum: () => maximum }
}

afterEach(() => { vi.unstubAllGlobals() })

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

  it('merges stale journals and serializes simultaneous cross-tab captures', async () => {
    const disk = storage(), shared = coordination()
    const first = new SubmissionJournal(disk, shared.lock), second = new SubmissionJournal(disk, shared.lock)
    await first.capture(ctx, signature())
    await second.capture(ctx, signature(2))
    await Promise.all([first.capture(ctx, signature(3)), second.capture(ctx, signature(4))])
    first.refreshFromStorage()
    second.refreshFromStorage()
    expect(first.getSnapshot().map((entry) => entry.signature).sort()).toEqual([1, 2, 3, 4].map(signature).sort())
    expect(second.getSnapshot()).toEqual(first.getSnapshot())
    expect(shared.maximum()).toBe(1)
  })

  it('checks duplicate context against fresh storage inside the lock', async () => {
    const disk = storage(), { lock } = coordination()
    const first = new SubmissionJournal(disk, lock), second = new SubmissionJournal(disk, lock)
    const results = await Promise.allSettled([
      first.capture(ctx, signature()), second.capture({ ...ctx, commitment: 'finalized' }, signature()),
    ])
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(new SubmissionJournal(disk).getSnapshot()[0]?.commitment).toBe(results[0]!.status === 'fulfilled' ? 'confirmed' : 'finalized')
    const rejected = results.find((result) => result.status === 'rejected')!
    if (rejected.status === 'rejected') expect(rejected.reason.message).toBe('Signature already recorded in another context.')
    expect(disk.setItem).toHaveBeenCalledTimes(1)
  })

  it('propagates explicit removal and never restores stale persisted receipts', async () => {
    const disk = storage(), { lock } = coordination()
    const first = new SubmissionJournal(disk, lock)
    await first.capture(ctx, signature())
    await first.capture(ctx, signature(2))
    const stale = new SubmissionJournal(disk, lock), observer = new SubmissionJournal(disk, lock)
    await first.remove(signature())
    observer.refreshFromStorage()
    expect(observer.getSnapshot().map((entry) => entry.signature)).toEqual([signature(2)])
    await stale.capture(ctx, signature(3))
    first.refreshFromStorage()
    expect(first.getSnapshot().map((entry) => entry.signature)).toEqual([signature(3), signature(2)])
    expect(new SubmissionJournal(disk).getSnapshot()).toEqual(first.getSnapshot())
  })

  it.each([true, false])('preserves other receipts during concurrent capture and removal (remove first: %s)', async (removeFirst) => {
    const disk = storage(), { lock } = coordination(), first = new SubmissionJournal(disk, lock)
    await first.capture(ctx, signature())
    const second = new SubmissionJournal(disk, lock)
    await Promise.all(removeFirst
      ? [first.remove(signature()), second.capture(ctx, signature(2))]
      : [second.capture(ctx, signature(2)), first.remove(signature())])
    expect(new SubmissionJournal(disk).getSnapshot().map((entry) => entry.signature)).toEqual([signature(2)])
  })

  it('keeps operation invocation order for a pending capture followed by removal', async () => {
    const disk = storage(), journal = new SubmissionJournal(disk, coordination().lock)
    await Promise.all([journal.capture(ctx, signature()), journal.remove(signature())])
    expect(journal.getSnapshot()).toHaveLength(0)
    expect(new SubmissionJournal(disk).getSnapshot()).toHaveLength(0)
  })

  it('retains a pending capture after lock rejection and processes the next queued capture', async () => {
    const disk = storage()
    let deny: ((error: Error) => void) | undefined
    let entered: (() => void) | undefined
    const ready = new Promise<void>((resolve) => { entered = resolve })
    const lock = vi.fn<JournalCoordinationLock>().mockImplementationOnce(async () => {
      entered!()
      await new Promise<void>((_resolve, reject) => { deny = reject })
    }).mockImplementation(async (operation) => { await operation() })
    const journal = new SubmissionJournal(disk, lock)
    const pending = expect(journal.capture(ctx, signature())).rejects.toThrow('only in this session')
    const next = journal.capture(ctx, signature(2))
    await ready
    expect(disk.setItem).not.toHaveBeenCalled()
    deny!(new Error('private lock detail'))
    await pending
    await next
    expect(journal.getSnapshot().map((entry) => entry.signature)).toEqual([signature(), signature(2)])
    expect(new SubmissionJournal(disk).getSnapshot().map((entry) => entry.signature)).toEqual([signature(2)])
    expect(journal.error).toBe('storage-unavailable')
    expect(Object.isFrozen(journal.getSnapshot())).toBe(true)
    expect(journal.getSnapshot().every(Object.isFrozen)).toBe(true)
    const original = journal.getSnapshot()[0]
    await journal.capture(ctx, signature())
    expect(journal.getSnapshot()[0]).toBe(original)
    expect(new SubmissionJournal(disk).getSnapshot()).toEqual(journal.getSnapshot())
    expect(journal.error).toBeUndefined()
  })

  it('enforces the byte bound on new receipts without leaving hidden volatile records', async () => {
    const disk = storage(), journal = new SubmissionJournal(disk, coordination().lock)
    const oversized = { ...ctx, deployment: { ...ctx.deployment, generatedAt: `2026-10-09T12:00:00.${'0'.repeat(128_001)}Z` } }
    await expect(journal.capture(oversized, signature())).rejects.toThrow('full')
    expect(journal.getSnapshot()).toHaveLength(0)
    expect(disk.setItem).not.toHaveBeenCalled()
    await journal.capture(ctx, signature(2))
    expect(new SubmissionJournal(disk).getSnapshot().map((entry) => entry.signature)).toEqual([signature(2)])
  })

  it('preserves volatile captures across refresh, external clear and subsequent coordinated writes', async () => {
    const disk = storage(), journal = new SubmissionJournal(disk, coordination().lock)
    await journal.capture(ctx, signature())
    disk.setItem.mockImplementationOnce(() => { throw new Error('private quota detail') })
    await expect(journal.capture(ctx, signature(2))).rejects.toThrow('only in this session')
    const pending = journal.getSnapshot()[0]
    disk.setItem('aveo.desk.submissions.v1', '[]')
    journal.refreshFromStorage()
    expect(journal.getSnapshot()).toEqual([pending])
    expect(Object.isFrozen(pending)).toBe(true)
    await journal.capture(ctx, signature(3))
    expect(new SubmissionJournal(disk).getSnapshot().map((entry) => entry.signature)).toEqual([signature(3)])
    expect(journal.getSnapshot().map((entry) => entry.signature)).toEqual([signature(2), signature(3)])
    expect(journal.error).toBe('storage-unavailable')
    await journal.capture(ctx, signature(2))
    expect(journal.getSnapshot()[0]).toBe(pending)
    expect(journal.error).toBeUndefined()
    disk.getItem.mockReturnValueOnce(null)
    journal.refreshFromStorage()
    expect(journal.getSnapshot()).toHaveLength(0)
  })

  it('fails closed when fresh storage conflicts with any volatile receipt context', async () => {
    const disk = storage(), { lock } = coordination(), journal = new SubmissionJournal(disk, lock)
    disk.setItem.mockImplementationOnce(() => { throw new Error('quota') })
    await expect(journal.capture(ctx, signature())).rejects.toThrow('only in this session')
    const original = journal.getSnapshot()[0]
    const external = new SubmissionJournal(disk, lock)
    await external.capture({ ...ctx, rpcUrl: 'https://different.invalid' }, signature())
    const incoming = disk.raw()
    disk.setItem.mockClear()
    journal.refreshFromStorage()
    expect(journal.error).toBe('invalid-records')
    expect(journal.getSnapshot()).toEqual([original])
    expect(journal.getSnapshot()[0]).toBe(original)
    await expect(journal.capture(ctx, signature(3))).rejects.toThrow('only in this session')
    expect(journal.error).toBe('invalid-records')
    expect(journal.getSnapshot().map((entry) => entry.signature)).toEqual([signature(3), signature()])
    expect(await journal.matches(ctx, journal.getSnapshot()[1]!)).toBe(true)
    journal.refreshFromStorage()
    await expect(journal.remove(signature())).rejects.toThrow('Could not remove')
    expect(journal.getSnapshot()[1]).toBe(original)
    expect(disk.raw()).toBe(incoming)
    expect(disk.setItem).not.toHaveBeenCalled()
  })

  it.each(['refresh', 'capture', 'failed removal'])('retires volatile receipts acknowledged through %s before another tab removes them', async (path) => {
    const disk = storage(), { lock } = coordination(), first = new SubmissionJournal(disk, lock)
    disk.setItem.mockImplementationOnce(() => { throw new Error('quota') })
    await expect(first.capture(ctx, signature())).rejects.toThrow('only in this session')
    const second = new SubmissionJournal(disk, lock)
    await second.capture(ctx, signature())
    if (path === 'refresh') first.refreshFromStorage()
    else if (path === 'capture') await first.capture(ctx, signature())
    else {
      disk.setItem.mockImplementationOnce(() => { throw new Error('quota') })
      await expect(first.remove(signature(9))).rejects.toThrow('Could not remove')
    }
    await second.remove(signature())
    first.refreshFromStorage()
    expect(first.getSnapshot()).toHaveLength(0)
    expect(first.error).toBeUndefined()
    await first.capture(ctx, signature(2))
    expect(new SubmissionJournal(disk).getSnapshot().map((entry) => entry.signature)).toEqual([signature(2)])
  })

  it.each(['capture', 'remove'])('does not flush unrelated volatile receipts during %s after missed save/removal hints', async (path) => {
    const disk = storage(), { lock } = coordination(), first = new SubmissionJournal(disk, lock)
    disk.setItem.mockImplementationOnce(() => { throw new Error('quota') })
    await expect(first.capture(ctx, signature())).rejects.toThrow('only in this session')
    const original = first.getSnapshot()[0]
    const second = new SubmissionJournal(disk, lock)
    await second.capture(ctx, signature())
    await second.remove(signature())
    // Both storage hints were missed: the volatile signature remains exportable.
    if (path === 'capture') await first.capture(ctx, signature(2))
    else await first.remove(signature(9))
    const stored = new SubmissionJournal(disk).getSnapshot()
    expect(stored.map((entry) => entry.signature)).toEqual(path === 'capture' ? [signature(2)] : [])
    expect(first.getSnapshot()[0]).toBe(original)
    expect(first.error).toBe('storage-unavailable')
    first.refreshFromStorage()
    expect(first.getSnapshot()[0]).toBe(original)
    await first.capture(ctx, signature())
    expect(new SubmissionJournal(disk).getSnapshot()[0]).toEqual(original)
    expect(first.error).toBeUndefined()
  })

  it.each(['refresh', 'capture', 'remove'])('does not retire any pending receipt when %s rejects a full, oversized, malformed or conflicting merge', async (path) => {
    for (const failure of ['full', 'oversized', 'malformed', 'conflict']) {
      const disk = storage(), { lock } = coordination(), journal = new SubmissionJournal(disk, lock)
      const largeCtx = { ...ctx, deployment: { ...ctx.deployment, generatedAt: `2026-10-09T12:00:00.${'0'.repeat(70_000)}Z` } }
      disk.setItem.mockImplementationOnce(() => { throw new Error('quota') })
      await expect(journal.capture(ctx, signature())).rejects.toThrow('only in this session')
      disk.setItem.mockImplementationOnce(() => { throw new Error('quota') })
      await expect(journal.capture(failure === 'oversized' ? largeCtx : ctx, signature(2))).rejects.toThrow('only in this session')
      const originals = journal.getSnapshot()
      const first = originals.find((entry) => entry.signature === signature())!
      const other = originals.find((entry) => entry.signature === signature(2))!
      const records = failure === 'full'
        ? [first, ...Array.from({ length: 99 }, (_, i) => ({ ...first, signature: signature(i + 3) }))]
        : failure === 'oversized'
          ? [first, { ...other, signature: signature(3) }]
          : failure === 'conflict'
            ? [first, { ...other, rpcFingerprint: 'f'.repeat(64) }]
            : [first, { signature: 'invalid' }]
      const raw = JSON.stringify(records)
      disk.setItem('aveo.desk.submissions.v1', raw)
      disk.setItem.mockClear()
      if (path === 'refresh') journal.refreshFromStorage()
      else if (path === 'capture') await expect(journal.capture(ctx, signature())).rejects.toThrow()
      else await expect(journal.remove(signature(9))).rejects.toThrow('Could not remove')
      expect(journal.error).toBe(failure === 'full' || failure === 'oversized' ? 'storage-full' : 'invalid-records')
      expect(journal.getSnapshot()).toEqual(originals)
      expect(disk.raw()).toBe(raw)
      expect(disk.setItem).not.toHaveBeenCalled()
      disk.setItem('aveo.desk.submissions.v1', '[]')
      journal.refreshFromStorage()
      expect(journal.getSnapshot().map((entry) => entry.signature).sort()).toEqual(originals.map((entry) => entry.signature).sort())
      expect(journal.getSnapshot().every((entry) => originals.includes(entry))).toBe(true)
      expect(journal.error).toBe('storage-unavailable')
    }
  })

  it.each(['full', 'oversized'])('does not acknowledge pending receipts when the requested capture exceeds the %s bound', async (failure) => {
    const disk = storage(), journal = new SubmissionJournal(disk, coordination().lock)
    disk.setItem.mockImplementationOnce(() => { throw new Error('quota') })
    await expect(journal.capture(ctx, signature())).rejects.toThrow('only in this session')
    const original = journal.getSnapshot()[0]!
    const stored = failure === 'full'
      ? [original, ...Array.from({ length: 99 }, (_, i) => ({ ...original, signature: signature(i + 2) }))]
      : [original]
    const raw = JSON.stringify(stored)
    disk.setItem('aveo.desk.submissions.v1', raw)
    disk.setItem.mockClear()
    const requestedCtx = failure === 'full' ? ctx : {
      ...ctx, deployment: { ...ctx.deployment, generatedAt: `2026-10-09T12:00:00.${'0'.repeat(128_001)}Z` },
    }
    await expect(journal.capture(requestedCtx, signature(101))).rejects.toThrow('full')
    expect(disk.raw()).toBe(raw)
    expect(disk.setItem).not.toHaveBeenCalled()
    disk.setItem('aveo.desk.submissions.v1', '[]')
    journal.refreshFromStorage()
    expect(journal.getSnapshot()).toEqual([original])
    expect(journal.getSnapshot()[0]).toBe(original)
    expect(journal.error).toBe('storage-unavailable')
  })

  it.each(['{', '[{"signature":"invalid","rpcUrl":"secret"}]', ' '.repeat(128_001)])('never overwrites malformed storage on capture or removal: %s', async (raw) => {
    const disk = storage()
    disk.setItem('aveo.desk.submissions.v1', raw)
    disk.setItem.mockClear()
    const journal = new SubmissionJournal(disk, coordination().lock)
    await expect(journal.capture(ctx, signature())).rejects.toThrow('only in this session')
    expect(journal.error).toBe('invalid-records')
    expect(journal.getSnapshot()).toHaveLength(1)
    journal.refreshFromStorage()
    await expect(journal.remove(signature())).rejects.toThrow('Could not remove the public submission receipt from storage.')
    expect(journal.getSnapshot()).toHaveLength(1)
    expect(disk.raw()).toBe(raw)
    expect(disk.setItem).not.toHaveBeenCalled()
  })

  it('retains captures and the original receipt on lock denial without exposing error details', async () => {
    const disk = storage(), seed = new SubmissionJournal(disk)
    await seed.capture(ctx, signature())
    const denied: JournalCoordinationLock = async () => { throw new Error('private endpoint') }
    const journal = new SubmissionJournal(disk, denied)
    await expect(journal.capture(ctx, signature(2))).rejects.toThrow('Public receipt is available only in this session.')
    await expect(journal.remove(signature())).rejects.toThrow('Could not remove the public submission receipt from storage.')
    expect(journal.error).toBe('storage-unavailable')
    expect(journal.getSnapshot().map((entry) => entry.signature)).toEqual([signature(2), signature()])
    expect(new SubmissionJournal(disk).getSnapshot()).toHaveLength(1)
  })

  it('preserves local receipts on read failure and does not write', async () => {
    const disk = storage(), journal = new SubmissionJournal(disk, coordination().lock)
    await journal.capture(ctx, signature())
    disk.getItem.mockImplementation(() => { throw new Error('private read detail') })
    await expect(journal.capture(ctx, signature(2))).rejects.toThrow('only in this session')
    journal.refreshFromStorage()
    expect(journal.getSnapshot()).toHaveLength(2)
    expect(journal.error).toBe('storage-unavailable')
    expect(disk.setItem).toHaveBeenCalledTimes(1)
  })

  it('keeps a receipt available after failed removal and permits a later retry', async () => {
    const disk = storage(), journal = new SubmissionJournal(disk, coordination().lock)
    await journal.capture(ctx, signature())
    const original = journal.getSnapshot()[0], before = disk.raw()
    disk.setItem.mockImplementationOnce(() => { throw new Error('quota') })
    await expect(journal.remove(signature())).rejects.toThrow('Could not remove')
    expect(journal.getSnapshot()[0]).toBe(original)
    expect(disk.raw()).toBe(before)
    await expect(journal.remove('invalid')).rejects.toThrow('Could not remove a public submission receipt.')
    await journal.remove(signature())
    expect(journal.getSnapshot()).toHaveLength(0)
  })

  it('keeps no-lock captures session-only and permits explicit local removal', async () => {
    const disk = storage(), journal = new SubmissionJournal(disk, null)
    await expect(journal.capture(ctx, signature())).rejects.toThrow('only in this session')
    journal.refreshFromStorage()
    expect(journal.getSnapshot()).toHaveLength(1)
    await journal.remove(signature())
    expect(journal.getSnapshot()).toHaveLength(0)
    expect(journal.error).toBe('storage-unavailable')
    expect(disk.setItem).not.toHaveBeenCalled()
  })

  it('loads no-lock persisted receipts read-only and rejects their removal', async () => {
    const disk = storage(), seed = new SubmissionJournal(disk)
    await seed.capture(ctx, signature())
    disk.setItem.mockClear()
    const journal = new SubmissionJournal(disk, null)
    const original = journal.getSnapshot()[0]
    await expect(journal.remove(signature())).rejects.toThrow('Could not remove the public submission receipt from storage.')
    expect(journal.getSnapshot()[0]).toBe(original)
    expect(journal.error).toBe('storage-unavailable')
    await expect(journal.capture(ctx, signature(2))).rejects.toThrow('only in this session')
    await journal.remove(signature(2))
    expect(journal.getSnapshot()).toEqual([original])
    expect(new SubmissionJournal(disk).getSnapshot()).toEqual([original])
    expect(disk.setItem).not.toHaveBeenCalled()
  })

  it('rejects no-lock removal when another tab has persisted a formerly volatile signature', async () => {
    const disk = storage(), journal = new SubmissionJournal(disk, null)
    await expect(journal.capture(ctx, signature())).rejects.toThrow('only in this session')
    await new SubmissionJournal(disk).capture(ctx, signature())
    const before = disk.raw()
    disk.setItem.mockClear()
    await expect(journal.remove(signature())).rejects.toThrow('Could not remove')
    expect(journal.getSnapshot()).toHaveLength(1)
    expect(disk.raw()).toBe(before)
    expect(disk.setItem).not.toHaveBeenCalled()
  })

  it('uses fresh storage capacity instead of a stale empty snapshot', async () => {
    const disk = storage(), { lock } = coordination(), writer = new SubmissionJournal(disk, lock)
    const stale = new SubmissionJournal(disk, lock)
    for (let n = 1; n <= 100; n++) await writer.capture(ctx, signature(n))
    const before = disk.raw()
    await expect(stale.capture(ctx, signature(101))).rejects.toThrow('full')
    expect(stale.getSnapshot()).toHaveLength(100)
    expect(disk.raw()).toBe(before)
    await stale.remove(signature())
    await stale.capture(ctx, signature(101))
    expect(new SubmissionJournal(disk).getSnapshot()).toHaveLength(100)
  })

  it('installs scoped browser refresh hints and ignores event payloads without RPC calls', async () => {
    const disk = storage(), shared = coordination()
    let hint: ((event: StorageEvent) => void) | undefined
    const addEventListener = vi.fn((_name: string, callback: (event: StorageEvent) => void) => { hint = callback })
    const request = vi.fn((_name: string, _options: unknown, operation: () => Promise<void>) => shared.lock(operation))
    const fetch = vi.fn()
    vi.stubGlobal('window', { addEventListener })
    vi.stubGlobal('localStorage', disk)
    vi.stubGlobal('navigator', { locks: { request } })
    vi.stubGlobal('fetch', fetch)
    vi.resetModules()
    const { getSubmissionJournal } = await import('./submission-journal')
    const journal = getSubmissionJournal()
    expect(getSubmissionJournal()).toBe(journal)
    expect(addEventListener).toHaveBeenCalledTimes(1)
    await journal.capture(ctx, signature())
    expect(request).toHaveBeenCalledWith('aveo.desk.submissions.v1', { mode: 'exclusive' }, expect.any(Function))
    disk.setItem('aveo.desk.submissions.v1', '[]')
    const emit = (key: string | null, storageArea: unknown, newValue = '{') => hint!({ key, storageArea, newValue } as StorageEvent)
    emit('wrong-key', disk)
    emit('aveo.desk.submissions.v1', storage())
    expect(journal.getSnapshot()).toHaveLength(1)
    emit('aveo.desk.submissions.v1', disk)
    expect(journal.getSnapshot()).toHaveLength(0)
    await journal.capture(ctx, signature(2))
    disk.setItem('aveo.desk.submissions.v1', '{')
    emit('aveo.desk.submissions.v1', disk, '[]')
    expect(journal.getSnapshot()).toHaveLength(1)
    expect(journal.error).toBe('invalid-records')
    disk.getItem.mockReturnValueOnce(null)
    emit(null, disk)
    expect(journal.getSnapshot()).toHaveLength(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('discovers unavailable browser locks and keeps storage untouched', async () => {
    const disk = storage()
    vi.stubGlobal('window', { addEventListener: vi.fn() })
    vi.stubGlobal('localStorage', disk)
    vi.stubGlobal('navigator', {})
    vi.resetModules()
    const { getSubmissionJournal } = await import('./submission-journal')
    const journal = getSubmissionJournal()
    await expect(journal.capture(ctx, signature())).rejects.toThrow('only in this session')
    expect(journal.getSnapshot()).toHaveLength(1)
    expect(disk.setItem).not.toHaveBeenCalled()
  })

  it('does not access browser storage or create a singleton during SSR', async () => {
    vi.stubGlobal('window', undefined)
    const disk = storage()
    vi.stubGlobal('localStorage', disk)
    vi.resetModules()
    const { getSubmissionJournal } = await import('./submission-journal')
    expect(getSubmissionJournal()).not.toBe(getSubmissionJournal())
    expect(disk.getItem).not.toHaveBeenCalled()
  })
})
