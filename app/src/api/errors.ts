// Tradução de falhas de transação para os códigos estáveis do contrato (6000–6014 e erros do Desk).
import { onchainErrorFromCode } from '@aveo/contracts'
import type { Address } from '@solana/kit'
import { reason, type DiagnosticReason } from './diagnostics'

const FAILED_LINE = /^Program (\w+) failed: custom program error: 0x([0-9a-fA-F]+)/
const ANCHOR_LINE = /Error Code: (\w+)\. Error Number: (\d+)/

/**
 * Lê os logs de uma simulação ou transação. Quando o hook falha dentro do CPI do Token-2022,
 * a primeira linha "failed" é a do hook; é ela que define o código estável.
 */
export function onchainReasonFromLogs(logs: readonly string[], hookProgramId: Address): DiagnosticReason | undefined {
  for (const line of logs) {
    const failed = FAILED_LINE.exec(line)
    if (failed && failed[1] === hookProgramId) {
      const code = onchainErrorFromCode(Number.parseInt(failed[2]!, 16))
      if (code) return reason(code, line)
    }
  }
  for (const line of logs) {
    const anchor = ANCHOR_LINE.exec(line)
    if (anchor) {
      const code = onchainErrorFromCode(Number(anchor[2]))
      if (code) return reason(code, line)
    }
  }
  return undefined
}

/** Primeira linha de falha de qualquer programa, para erros que não são do hook (ex.: saldo insuficiente). */
export function firstFailureLine(logs: readonly string[]): string | undefined {
  return logs.find((line) => /failed/.test(line) || /Error:/.test(line))
}

export function failureReason(err: unknown, logs: readonly string[], hookProgramId: Address): DiagnosticReason {
  const onchain = onchainReasonFromLogs(logs, hookProgramId)
  if (onchain) return onchain
  const detail = firstFailureLine(logs) ?? (typeof err === 'object' ? JSON.stringify(err, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) : String(err))
  return reason('SimulationFailed', detail)
}
