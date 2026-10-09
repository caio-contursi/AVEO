import { exportPublicReceipt } from './receipt-export'

const MAX_RECEIPTS = 100
const MAX_BYTES = 128_000

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
    const bytes = new TextEncoder().encode(JSON.stringify(sanitized)).length
    if (bytes > MAX_BYTES) return undefined
    return {
      count: sanitized.length, bytes,
      nearFull: sanitized.length >= 90 || bytes >= MAX_BYTES * 0.9,
      full: sanitized.length === MAX_RECEIPTS || bytes === MAX_BYTES,
    }
  } catch {
    return undefined
  }
}
