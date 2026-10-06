import type { DiagnosticReason } from '../api/diagnostics'
import type { I18nValue } from '../i18n/context'
import type { MessageKey } from '../i18n/messages'

const PLACEHOLDER = /\{(\w+)\}/g

/** Escolhe a mensagem traduzida de um motivo a partir do código e dos parâmetros. */
export function describeReason(i18n: Pick<I18nValue, 't' | 'has'>, reason: DiagnosticReason): string {
  const params: Record<string, string> = { ...(reason.params ?? {}) }
  if (params.fact) params.fact = i18n.t(params.fact === 'kyc' ? 'fact.kyc' : 'fact.accredited')
  if (reason.side) params.side = i18n.t(reason.side === 'source' ? 'side.source' : 'side.destination')

  let key = `reason.${reason.code}`
  if (reason.code === 'BindingMissing' && params.available) key = 'reason.BindingMissing.available'
  else if (reason.code === 'AttestationMissingOrClosed' && reason.hint) key = 'reason.AttestationMissingOrClosed.hint'
  else if (reason.code === 'SimulationFailed' && params.missing === 'token-account') key = 'reason.SimulationFailed.token-account'
  if (!i18n.has(key)) return reason.message

  // Um erro lido dos logs pode chegar sem ativo, verificador ou fato: usa a frase sem eles.
  const template = i18n.t(key as MessageKey)
  const missing = [...template.matchAll(PLACEHOLDER)].some(([, name]) => !(name! in params))
  if (missing && i18n.has(`${key}.generic`)) return i18n.t(`${key}.generic` as MessageKey)
  return i18n.t(key as MessageKey, { asset: '—', verifier: '—', ...params })
}
