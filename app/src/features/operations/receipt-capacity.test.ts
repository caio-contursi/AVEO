import { getAddressDecoder, getBase58Decoder } from '@solana/kit'
import { describe, expect, it } from 'vitest'
import { receiptCapacity } from './receipt-capacity'
import { exportPublicReceipt, exportPublicReceiptHistory } from './receipt-export'

function receipt(index = 1) {
  return {
    version: 1, signature: getBase58Decoder().decode(new Uint8Array(64).fill(index)),
    submittedAt: '2026-10-09T12:00:00.000Z', cluster: 'devnet',
    programId: getAddressDecoder().decode(new Uint8Array(32).fill(7)), commitment: 'confirmed',
    deploymentGeneratedAt: '2026-10-09T12:00:00.000Z', rpcFingerprint: 'a'.repeat(64),
  }
}

function atBytes(bytes: number) {
  const entry = receipt()
  const size = new TextEncoder().encode(JSON.stringify([entry])).length
  return { ...entry, submittedAt: `2026-10-09T12:00:00.${'0'.repeat(3 + bytes - size)}Z` }
}

describe('visible receipt snapshot capacity', () => {
  it('counts zero receipts and the two bytes of the empty compact array', () => {
    expect(receiptCapacity([])).toEqual({ count: 0, bytes: 2, nearFull: false, full: false })
  })

  it('matches compact journal serialization rather than pretty export bytes', () => {
    const entries = [receipt(), receipt(2)]
    const bytes = new TextEncoder().encode(JSON.stringify(entries)).length
    expect(receiptCapacity(entries)).toEqual({ count: 2, bytes, nearFull: false, full: false })
    expect(bytes).toBeLessThan(new TextEncoder().encode(exportPublicReceiptHistory(entries)!).length)
  })

  it.each([89, 90, 99, 100])('handles the %i-receipt boundary', (count) => {
    const entries = Array.from({ length: count }, (_, index) => receipt(index + 1))
    expect(receiptCapacity(entries)).toEqual({
      count, bytes: new TextEncoder().encode(JSON.stringify(entries)).length,
      nearFull: count >= 90, full: count === 100,
    })
  })

  it.each([115199, 115200, 127999, 128000, 128001])('handles the %i-byte boundary with real valid metadata', (bytes) => {
    const entry = atBytes(bytes)
    expect(exportPublicReceipt(entry)).toBeDefined()
    expect(new TextEncoder().encode(JSON.stringify([entry])).length).toBe(bytes)
    expect(receiptCapacity([entry])).toEqual(bytes > 128000 ? undefined : {
      count: 1, bytes, nearFull: bytes >= 115200, full: bytes === 128000,
    })
  })

  it('rejects over-count, duplicates, non-arrays and malformed known fields without partial results', () => {
    for (const input of [null, {}, '[]', [null], [receipt(), receipt()],
      Array.from({ length: 101 }, (_, index) => receipt(index + 1)),
      ...Object.keys(receipt()).map((key) => [receipt(), { ...receipt(2), [key]: null }]),
      [receipt(), { ...receipt(2), signature: 'invalid' }],
    ]) expect(receiptCapacity(input)).toBeUndefined()
  })

  it('strips unknown Unicode fields and does not mutate the snapshot', () => {
    const clean = receipt()
    const entry = Object.freeze({ ...clean, note: 'ação 🔒'.repeat(30000), rpcUrl: 'private', keys: ['secret'] })
    const entries = Object.freeze([entry])
    expect(receiptCapacity(entries)).toEqual(receiptCapacity([clean]))
    expect(entry.note).toHaveLength('ação 🔒'.length * 30000)
    expect(entries[0]).toBe(entry)
  })

  it('does not expose errors from hostile metadata or array access', () => {
    const entry = { ...receipt(), get signature(): string { throw new Error('private metadata') } }
    expect(receiptCapacity([entry])).toBeUndefined()
    expect(receiptCapacity(new Proxy([], { get() { throw new Error('private array') } }))).toBeUndefined()
  })
})
