import { getAddressDecoder, getBase58Decoder } from '@solana/kit'
import { describe, expect, it, vi } from 'vitest'
import type { ApiContext } from '../../api/context'
import { receiptCapacity } from './receipt-capacity'
import { exportPublicReceiptHistory } from './receipt-export'
import { MAX_RECEIPTS, MAX_RECEIPT_BYTES } from './receipt-limits'
import { SubmissionJournal } from './submission-journal'

const programId = getAddressDecoder().decode(new Uint8Array(32).fill(7))
const signature = (index: number) => getBase58Decoder().decode(new Uint8Array(64).fill(index))
const ctx = {
  cluster: 'localnet', commitment: 'confirmed', programId,
  rpcUrl: 'http://127.0.0.1:8899',
  deployment: { generatedAt: '2026-10-09T12:00:00.000Z' },
} as ApiContext

function receipt(index = 1) {
  return {
    version: 1, signature: signature(index), submittedAt: '2026-10-09T12:00:00.000Z',
    cluster: 'localnet', programId, commitment: 'confirmed',
    deploymentGeneratedAt: ctx.deployment.generatedAt, rpcFingerprint: 'a'.repeat(64),
  }
}

const bytes = (text: string) => new TextEncoder().encode(text).length

function receiptAtCompactBytes(size: number) {
  const entry = receipt()
  const padding = size - bytes(JSON.stringify([entry]))
  return { ...entry, submittedAt: `2026-10-09T12:00:00.${'0'.repeat(3 + padding)}Z` }
}

function storage(raw: string) {
  let current = raw
  return {
    getItem: vi.fn(() => current),
    setItem: vi.fn((_key: string, next: string) => { current = next }),
    raw: () => current,
  }
}

describe('receipt limits across journal, capacity and public export', () => {
  it.each([0, 89, 90, 99, 100])('agrees on a valid %i-receipt snapshot without mutating storage', (count) => {
    const entries = Array.from({ length: count }, (_, index) => receipt(index + 1))
    const disk = storage(JSON.stringify(entries))
    const journal = new SubmissionJournal(disk)
    const snapshot = journal.getSnapshot()
    expect(journal.error).toBeUndefined()
    expect(snapshot).toEqual(entries)
    expect(receiptCapacity(snapshot)).toEqual({
      count, bytes: bytes(disk.raw()), nearFull: count >= 90, full: count === 100,
    })
    expect(JSON.parse(exportPublicReceiptHistory(snapshot)!).receipts).toEqual(entries)
    expect(disk.setItem).not.toHaveBeenCalled()
  })

  it('rejects the next capture without silently evicting or losing an exportable full history', async () => {
    const disk = storage('[]')
    const journal = new SubmissionJournal(disk)
    for (let index = 1; index <= MAX_RECEIPTS; index++) await journal.capture(ctx, signature(index))
    const before = disk.raw()
    const snapshot = journal.getSnapshot()
    expect(receiptCapacity(snapshot)?.full).toBe(true)
    const exported = exportPublicReceiptHistory(snapshot)
    expect(JSON.parse(exported!).receipts).toHaveLength(100)
    await expect(journal.capture(ctx, signature(101))).rejects.toThrow('full')
    expect(disk.raw()).toBe(before)
    expect(journal.getSnapshot()).toEqual(snapshot)
    journal.getSnapshot().forEach((entry, index) => expect(entry).toBe(snapshot[index]))
    expect(exportPublicReceiptHistory(journal.getSnapshot())).toBe(exported)
    expect(journal.error).toBe('storage-full')
  })

  it.each([-1, 0, 1])('preserves distinct compact-storage and pretty-export byte limits at offset %i', (offset) => {
    const entries = [receiptAtCompactBytes(MAX_RECEIPT_BYTES + offset)]
    const disk = storage(JSON.stringify(entries))
    expect(bytes(disk.raw())).toBe(128_000 + offset)
    const journal = new SubmissionJournal(disk)
    if (offset <= 0) {
      expect(journal.error).toBeUndefined()
      expect(journal.getSnapshot()).toEqual(entries)
      expect(receiptCapacity(journal.getSnapshot())).toEqual({
        count: 1, bytes: 128_000 + offset, nearFull: true, full: offset === 0,
      })
      // A valid stored snapshot need not fit the larger pretty-printed envelope.
      expect(exportPublicReceiptHistory(journal.getSnapshot())).toBeUndefined()
    } else {
      expect(journal.error).toBe('invalid-records')
      expect(journal.getSnapshot()).toHaveLength(0)
      expect(receiptCapacity(entries)).toBeUndefined()
      expect(exportPublicReceiptHistory(entries)).toBeUndefined()
    }
    expect(disk.setItem).not.toHaveBeenCalled()
    expect(disk.raw()).toBe(JSON.stringify(entries))
  })

  it('strips unknown Unicode metadata consistently without confusing byte count with string length', () => {
    const entries = [receipt()]
    const untrusted = [{ ...entries[0], privateNote: 'ação 🔒'.repeat(500), rpcUrl: 'private' }]
    const disk = storage(JSON.stringify(untrusted))
    expect(bytes(disk.raw())).toBeGreaterThan(disk.raw().length)
    const journal = new SubmissionJournal(disk)
    expect(journal.error).toBeUndefined()
    expect(journal.getSnapshot()).toEqual(entries)
    expect(receiptCapacity(untrusted)).toEqual(receiptCapacity(journal.getSnapshot()))
    expect(exportPublicReceiptHistory(untrusted)).toBe(exportPublicReceiptHistory(journal.getSnapshot()))
    expect(exportPublicReceiptHistory(untrusted)).not.toContain('private')
    expect(disk.setItem).not.toHaveBeenCalled()
  })

  it.each([128_000, 128_001])('checks the complete pretty export envelope at %i bytes', (size) => {
    const entry = receipt()
    const base = bytes(exportPublicReceiptHistory([entry])!)
    const entries = [{ ...entry, submittedAt: `2026-10-09T12:00:00.${'0'.repeat(3 + size - base)}Z` }]
    const disk = storage(JSON.stringify(entries))
    const journal = new SubmissionJournal(disk)
    expect(bytes(disk.raw())).toBeLessThan(MAX_RECEIPT_BYTES)
    expect(journal.error).toBeUndefined()
    expect(receiptCapacity(journal.getSnapshot())?.full).toBe(false)
    const text = exportPublicReceiptHistory(journal.getSnapshot())
    if (size === 128_000) expect(bytes(text!)).toBe(128_000)
    else expect(text).toBeUndefined()
    expect(disk.setItem).not.toHaveBeenCalled()
  })

  it('bounds raw storage bytes before stripping unknown Unicode fields', () => {
    const entries = [receipt()]
    const untrusted = [{ ...entries[0], note: '🔒'.repeat(40_000) }]
    const disk = storage(JSON.stringify(untrusted))
    expect(disk.raw().length).toBeLessThan(MAX_RECEIPT_BYTES)
    expect(bytes(disk.raw())).toBeGreaterThan(MAX_RECEIPT_BYTES)
    const journal = new SubmissionJournal(disk)
    expect(journal.error).toBe('invalid-records')
    expect(journal.getSnapshot()).toHaveLength(0)
    expect(receiptCapacity(untrusted)).toEqual(receiptCapacity(entries))
    expect(exportPublicReceiptHistory(untrusted)).toBe(exportPublicReceiptHistory(entries))
    expect(disk.setItem).not.toHaveBeenCalled()
  })

  it.each([
    [receipt(), receipt()],
    [receipt(), { ...receipt(2), rpcFingerprint: 'invalid' }],
    Array.from({ length: 101 }, (_, index) => receipt(index + 1)),
  ].map((entries) => ({ entries })))('rejects an invalid collection in every consumer without partial acceptance', ({ entries }) => {
    const disk = storage(JSON.stringify(entries))
    const journal = new SubmissionJournal(disk)
    expect(journal.error).toBe('invalid-records')
    expect(journal.getSnapshot()).toHaveLength(0)
    expect(receiptCapacity(entries)).toBeUndefined()
    expect(exportPublicReceiptHistory(entries)).toBeUndefined()
    expect(disk.setItem).not.toHaveBeenCalled()
  })
})
