import { isAddress, isSignature } from '@solana/kit'
import { z } from 'zod'

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
