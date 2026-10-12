// Shared bounds only; each consumer owns validation and serialization.
export const MAX_RECEIPTS = 100
export const MAX_RECEIPT_BYTES = 128_000
export const NEAR_FULL_RATIO = 0.9

/** Measure the caller's exact text without parsing, sanitizing, or reformatting it. */
export function receiptUtf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}
