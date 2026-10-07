// A mensagem nunca mostra "—" ou um {placeholder} cru quando o motivo chega sem parâmetros.
import { describe, expect, it } from 'vitest'
import { messages, type MessageKey } from '../i18n/messages'
import { describeReason } from './describeReason'

const pt = messages.pt as Record<MessageKey, string>
const i18n = {
  t: (key: MessageKey, params: Record<string, string | number> = {}) =>
    pt[key].replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match)),
  has: (key: string): key is MessageKey => key in pt,
}

describe('describeReason', () => {
  it('usa o ativo e o verificador quando eles vêm no motivo', () => {
    const text = describeReason(i18n, { code: 'ProviderPairNotAllowed', message: 'x', params: { asset: 'Ativo Beta', verifier: 'Verificador B' } })
    expect(text).toBe('Ativo Beta não aceita provas do Verificador B')
  })

  it('cai na frase genérica quando o erro dos logs vem só com o código', () => {
    expect(describeReason(i18n, { code: 'ProviderPairNotAllowed', message: 'x' })).toBe('Este ativo não aceita o verificador desta prova')
    expect(describeReason(i18n, { code: 'RequiredFactMissing', message: 'x' })).toBe('A prova não comprova um fato que a política exige')
  })

  it('traduz o fato exigido', () => {
    expect(describeReason(i18n, { code: 'RequiredFactMissing', message: 'x', params: { fact: 'accredited' } })).toBe('A prova não comprova credenciamento')
  })

  it('motivos sem parâmetros continuam com a frase de sempre', () => {
    expect(describeReason(i18n, { code: 'AttestationExpired', message: 'x' })).toBe('A prova venceu')
  })
})
