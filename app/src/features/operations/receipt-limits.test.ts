import { describe, expect, it } from 'vitest'
import { MAX_RECEIPTS, MAX_RECEIPT_BYTES, NEAR_FULL_RATIO, receiptUtf8Bytes } from './receipt-limits'

describe('shared receipt limits', () => {
  it('preserves the count, byte and near-full boundaries', () => {
    expect(MAX_RECEIPTS).toBe(100)
    expect(MAX_RECEIPT_BYTES).toBe(128_000)
    expect(NEAR_FULL_RATIO).toBe(0.9)
    expect(MAX_RECEIPTS * NEAR_FULL_RATIO).toBe(90)
    expect(MAX_RECEIPT_BYTES * NEAR_FULL_RATIO).toBe(115_200)
  })

  it.each([
    ['', 0], ['[]', 2], ['receipt', 7], ['ação 🔒', 11],
    ['\ud800', 3], ['\udc00', 3], ['\ud83d\udd12', 4],
  ])('measures UTF-8 bytes for %j', (text, bytes) => {
    expect(receiptUtf8Bytes(text)).toBe(bytes)
  })

  it.each([115_199, 115_200, 127_999, 128_000, 128_001])('measures %i bytes without imposing a limit', (bytes) => {
    expect(receiptUtf8Bytes('a'.repeat(bytes))).toBe(bytes)
  })

  it('measures exact serialized text, preserving compact versus pretty envelope sizes', () => {
    const receipts = [{ note: 'ação 🔒' }]
    const compact = JSON.stringify(receipts)
    const pretty = JSON.stringify({ version: 1, kind: 'aveo-public-submission-history', receipts }, null, 2)
    expect(receiptUtf8Bytes(compact)).toBe(24)
    expect(receiptUtf8Bytes(pretty)).toBe(123)
    expect(receipts).toEqual([{ note: 'ação 🔒' }])
  })
})
