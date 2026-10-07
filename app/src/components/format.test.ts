// Prazos como "vence em 1 dia": singular e plural nos dois idiomas.
import { describe, expect, it } from 'vitest'
import { messages, type MessageKey } from '../i18n/messages'
import { formatExpiry, formatSpan } from './format'

const translator = (language: 'pt' | 'en') => {
  const dictionary = messages[language] as Record<MessageKey, string>
  return (key: MessageKey, params: Record<string, string | number> = {}) =>
    dictionary[key].replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
}

describe('formatSpan', () => {
  const pt = translator('pt')
  const en = translator('en')

  it('usa o singular para um dia', () => {
    expect(formatSpan(pt, 86_400)).toBe('1 dia')
    expect(formatSpan(en, 86_400)).toBe('1 day')
  })

  it('usa o plural para mais de um dia', () => {
    expect(formatSpan(pt, 30 * 86_400)).toBe('30 dias')
    expect(formatSpan(en, 2 * 86_400)).toBe('2 days')
  })

  it('mantém minutos e horas', () => {
    expect(formatSpan(pt, 20 * 60)).toBe('20 min')
    expect(formatSpan(pt, 5 * 3600)).toBe('5 h')
  })

  it('monta a frase de validade pelo relógio da rede', () => {
    expect(formatExpiry(pt, 1_000 + 86_400, 1_000)).toBe('vence em 1 dia')
    expect(formatExpiry(pt, 1_000, 1_000 + 2 * 86_400)).toBe('venceu há 2 dias')
  })
})
