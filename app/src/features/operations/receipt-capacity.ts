import { exportPublicReceipt } from './receipt-export'
import { MAX_RECEIPTS, MAX_RECEIPT_BYTES, NEAR_FULL_RATIO, receiptUtf8Bytes } from './receipt-limits'

/** Measures only sanitized visible metadata, never storage availability or browser quota. */
export function receiptCapacity(receipts: unknown): {
  count: number; bytes: number; nearFull: boolean; full: boolean
} | undefined {
  try {
    if (!Array.isArray(receipts) || receipts.length > MAX_RECEIPTS) return undefined
    const sanitized: Record<string, unknown>[] = []
    const signatures = new Set<unknown>()
    for (const receipt of receipts) {
      const text = exportPublicReceipt(receipt)
      if (text === undefined) return undefined
      const entry = JSON.parse(text).receipt as Record<string, unknown>
      if (signatures.has(entry.signature)) return undefined
      signatures.add(entry.signature)
      sanitized.push(entry)
    }
    // Journal storage is a compact array, not the pretty public export envelope.
    const bytes = receiptUtf8Bytes(JSON.stringify(sanitized))
    if (bytes > MAX_RECEIPT_BYTES) return undefined
    return {
      count: sanitized.length, bytes,
      nearFull: sanitized.length >= MAX_RECEIPTS * NEAR_FULL_RATIO || bytes >= MAX_RECEIPT_BYTES * NEAR_FULL_RATIO,
      full: sanitized.length === MAX_RECEIPTS || bytes === MAX_RECEIPT_BYTES,
    }
  } catch {
    return undefined
  }
}
