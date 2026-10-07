import type { I18nValue } from '../i18n/context'

export function formatSpan(t: I18nValue['t'], seconds: number): string {
  const abs = Math.abs(seconds)
  if (abs < 3600) return t('span.min', { n: Math.max(1, Math.round(abs / 60)) })
  if (abs < 86_400) return t('span.h', { n: Math.round(abs / 3600) })
  const days = Math.round(abs / 86_400)
  return t(days === 1 ? 'span.d.one' : 'span.d', { n: days })
}

/** Validade relativa ao relógio da rede (Clock sysvar), que é o que o hook usa. */
export function formatExpiry(t: I18nValue['t'], expiry: bigint | number, clockUnix: number): string {
  const diff = Number(expiry) - clockUnix
  return diff > 0 ? t('expiry.in', { span: formatSpan(t, diff) }) : t('expiry.ago', { span: formatSpan(t, diff) })
}

export function formatClock(locale: string, unix: number): string {
  return new Date(unix * 1000).toLocaleString(locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function formatSlot(locale: string, slot: number): string {
  return slot.toLocaleString(locale)
}

export function formatAmount(locale: string, amount: bigint, decimals: number): string {
  if (decimals === 0) return amount.toLocaleString(locale)
  const base = 10n ** BigInt(decimals)
  const whole = amount / base
  const fraction = (amount % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  return fraction ? `${whole.toLocaleString(locale)},${fraction}` : whole.toLocaleString(locale)
}

export function shortAddress(value: string): string {
  return value.length > 12 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value
}
