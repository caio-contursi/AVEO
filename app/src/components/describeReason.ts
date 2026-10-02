import type { DiagnosticReason } from '../api/diagnostics'
import type { I18nValue } from '../i18n/context'
import type { MessageKey } from '../i18n/messages'

/** Escolhe a mensagem traduzida de um motivo a partir do código e dos parâmetros. */
export function describeReason(i18n: Pick<I18nValue, 't' | 'has'>, reason: DiagnosticReason): string {
  const params: Record<string, string> = { ...(reason.params ?? {}) }
  if (params.fact) params.fact = i18n.t(params.fact === 'kyc' ? 'fact.kyc' : 'fact.accredited')
  if (reason.side) params.side = i18n.t(reason.side === 'source' ? 'side.source' : 'side.destination')
  params.asset ??= '—'
  params.verifier ??= '—'

  let key = `reason.${reason.code}`
  if (reason.code === 'BindingMissing' && params.available) key = 'reason.BindingMissing.available'
  else if (reason.code === 'AttestationMissingOrClosed' && reason.hint) key = 'reason.AttestationMissingOrClosed.hint'
  else if (reason.code === 'SimulationFailed' && params.missing === 'token-account') key = 'reason.SimulationFailed.token-account'
  return i18n.has(key) ? i18n.t(key as MessageKey, params) : reason.message
}
