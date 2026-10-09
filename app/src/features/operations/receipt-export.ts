import { isAddress, isSignature } from '@solana/kit'
import { z } from 'zod'
import { MAX_RECEIPTS, MAX_RECEIPT_BYTES, receiptUtf8Bytes } from './receipt-limits'

// Independent allowlist: browser metadata is never proof of chain confirmation.
const publicReceiptSchema = z.object({
  version: z.literal(1),
  signature: z.string().refine(isSignature),
  submittedAt: z.iso.datetime(),
  cluster: z.enum(['localnet', 'devnet']),
  programId: z.string().refine(isAddress),
  commitment: z.enum(['processed', 'confirmed', 'finalized']),
  deploymentGeneratedAt: z.iso.datetime(),
  rpcFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
})

/** One canonical serialization for both sizing and export; never a partial snapshot. */
function preparePublicReceiptHistory(receipts: unknown): { text: string; bytes: number } | undefined {
  try {
    if (!Array.isArray(receipts) || receipts.length > MAX_RECEIPTS) return undefined
    const parsed = z.array(publicReceiptSchema).max(MAX_RECEIPTS).safeParse(receipts)
    if (!parsed.success || new Set(parsed.data.map((receipt) => receipt.signature)).size !== parsed.data.length) return undefined
    const text = JSON.stringify({ version: 1, kind: 'aveo-public-submission-history', receipts: parsed.data }, null, 2)
    return { text, bytes: receiptUtf8Bytes(text) }
  } catch {
    return undefined
  }
}

export type ReceiptHistoryExportPreview =
  | { status: 'invalid'; maxBytes: number }
  | { status: 'ready' | 'tooLarge'; bytes: number; maxBytes: number }

/** Exact sanitized public-envelope bytes, not journal storage or browser quota. */
export function inspectPublicReceiptHistory(receipts: unknown): ReceiptHistoryExportPreview {
  const prepared = preparePublicReceiptHistory(receipts)
  if (!prepared) return { status: 'invalid', maxBytes: MAX_RECEIPT_BYTES }
  return {
    status: prepared.bytes <= MAX_RECEIPT_BYTES ? 'ready' : 'tooLarge',
    bytes: prepared.bytes, maxBytes: MAX_RECEIPT_BYTES,
  }
}

/** Export one bounded snapshot, never a partial collection of valid-looking records. */
export function exportPublicReceiptHistory(receipts: unknown): string | undefined {
  const prepared = preparePublicReceiptHistory(receipts)
  return prepared && prepared.bytes <= MAX_RECEIPT_BYTES ? prepared.text : undefined
}

/** Strip unknown fields and reject malformed known fields without exposing input or errors. */
export function exportPublicReceipt(receipt: unknown): string | undefined {
  try {
    const parsed = publicReceiptSchema.safeParse(receipt)
    if (!parsed.success) return undefined
    return JSON.stringify({ version: 1, kind: 'aveo-public-submission-receipt', receipt: parsed.data }, null, 2)
  } catch {
    return undefined
  }
}

export type ReceiptCopyResult =
  | { status: 'copied' }
  | { status: 'copyFailed'; text: string }
  | { status: 'invalidExport' }

/** Call only on user request. No scope matching, RPC, wallet, or transaction access. */
export async function copyPublicReceipt(
  receipt: unknown, isCurrent: () => boolean = () => true,
): Promise<ReceiptCopyResult | undefined> {
  if (!isCurrent()) return undefined
  const text = exportPublicReceipt(receipt)
  return copyExportedText(text, isCurrent)
}

/** Snapshot export only; no import, storage mutation, network, or wallet access. */
export async function copyPublicReceiptHistory(
  receipts: unknown, isCurrent: () => boolean = () => true,
): Promise<ReceiptCopyResult | undefined> {
  if (!isCurrent()) return undefined
  return copyExportedText(exportPublicReceiptHistory(receipts), isCurrent)
}

async function copyExportedText(text: string | undefined, isCurrent: () => boolean): Promise<ReceiptCopyResult | undefined> {
  if (!isCurrent()) return undefined
  if (text === undefined) return { status: 'invalidExport' }
  let result: ReceiptCopyResult
  try {
    await navigator.clipboard.writeText(text)
    result = { status: 'copied' }
  } catch {
    result = { status: 'copyFailed', text }
  }
  return isCurrent() ? result : undefined
}
