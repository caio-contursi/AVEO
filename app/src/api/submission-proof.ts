import { getBase64Encoder, getSignatureFromTransaction, getTransactionDecoder, isSignature, type Signature } from '@solana/kit'
import type { ApiContext } from './context'

export async function messageFingerprint(bytes: ArrayLike<number>): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export interface BoundSubmissionProof {
  signature: string
  status: 'confirmed' | 'failed'
  slot: number
  verifiedMessageFingerprint: string
}

/** Conservative RPC error subset: unsupported transaction errors cannot establish failure. */
function supportedInstructionError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || Array.isArray(error) ||
    Object.keys(error).length !== 1 || !Object.hasOwn(error, 'InstructionError') || !('InstructionError' in error)) return false
  const instruction = error.InstructionError
  if (!Array.isArray(instruction) || instruction.length !== 2) return false
  const [index, reason] = instruction
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 255) return false
  if (typeof reason === 'string') return reason.length > 0 && reason.length <= 128
  if (!reason || typeof reason !== 'object' || Array.isArray(reason) ||
    Object.keys(reason).length !== 1 || !Object.hasOwn(reason, 'Custom')) return false
  return typeof reason.Custom === 'number' && Number.isInteger(reason.Custom) && reason.Custom >= 0 && reason.Custom <= 0xffff_ffff
}

/** Original message equality is required; receipt metadata and current balances are insufficient. */
export async function verifySubmissionMessage(ctx: ApiContext, signature: string, expectedFingerprint: string): Promise<BoundSubmissionProof | undefined> {
  if (!isSignature(signature) || !/^[a-f0-9]{64}$/.test(expectedFingerprint) || ctx.commitment === 'processed') return undefined
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      ctx.rpc.getTransaction(signature as Signature, {
        encoding: 'base64', maxSupportedTransactionVersion: 0, commitment: ctx.commitment,
      }).send({ abortSignal: controller.signal }),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => { resolve(undefined); controller.abort() }, 10_000)
      }),
    ])
    if (!result) return undefined
    const rawSlot: unknown = result.slot
    if (typeof rawSlot !== 'number' && typeof rawSlot !== 'bigint') return undefined
    const slot = Number(rawSlot)
    if (!Number.isSafeInteger(slot) || slot <= 0) return undefined
    const meta = result.meta
    if (!meta || typeof meta !== 'object' || Array.isArray(meta) || !Object.hasOwn(meta, 'err')) return undefined
    const error: unknown = meta.err
    if (error !== null && !supportedInstructionError(error)) return undefined
    const encoded = result.transaction
    if (!Array.isArray(encoded) || encoded.length !== 2 || encoded[1] !== 'base64' || typeof encoded[0] !== 'string' || encoded[0].length > 4096) return undefined
    const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(encoded[0]))
    if (getSignatureFromTransaction(transaction) !== signature) return undefined
    const verifiedMessageFingerprint = await messageFingerprint(transaction.messageBytes)
    if (verifiedMessageFingerprint !== expectedFingerprint) return undefined
    return { signature, slot, status: error === null ? 'confirmed' : 'failed', verifiedMessageFingerprint }
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}
