import { createContext, useContext } from 'react'
import type { Language, MessageKey } from './messages'

export interface I18nValue {
  language: Language
  setLanguage: (language: Language) => void
  t: (key: MessageKey, params?: Record<string, string | number>) => string
  locale: string
  has: (key: string) => key is MessageKey
}

export const I18nContext = createContext<I18nValue | null>(null)

export function useI18n(): I18nValue {
  const value = useContext(I18nContext)
  if (!value) throw new Error('useI18n outside I18nProvider')
  return value
}
