// Tipos do diagnóstico do Desk. Estendem os contratos de @aveo/contracts sem alterá-los:
// a interface traduz cada motivo a partir do código + parâmetros; `message` fica como texto de apoio.
import type { DeskErrorCode, EligibilitySnapshot, OnchainError, Reason, Side } from '@aveo/contracts'
import type { Address } from '@solana/kit'

export type ReasonCode = OnchainError | DeskErrorCode

export interface DiagnosticReason extends Reason {
  side?: Side
  /** Parâmetros para a mensagem traduzida (ex.: { fact: 'kyc' }). */
  params?: Record<string, string>
  /** true quando o motivo explica algo que não é o erro devolvido pelo hook (ex.: prova disponível sem vínculo). */
  hint?: boolean
}

export interface ProofInfo {
  attestation: Address
  credential: Address
  schema: Address
  signer: Address
  expiry: bigint
  kycPass: boolean
  accreditedPass: boolean
}

export interface DeskSnapshot extends EligibilitySnapshot {
  reasons: DiagnosticReason[]
  proof?: ProofInfo
  /** unix_timestamp do sysvar Clock no slot lido: é ele que decide a validade da prova. */
  clockUnix?: number
}

export function reason(code: ReasonCode, message: string, extra: Omit<DiagnosticReason, 'code' | 'message'> = {}): DiagnosticReason {
  return { code, message, ...extra }
}
