import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { I18nContext, type I18nValue } from './context'
import { messages, type Language, type MessageKey } from './messages'

const STORAGE_KEY = 'aveo.language'

function initialLanguage(): Language {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'pt' || stored === 'en') return stored
  } catch {
    // localStorage indisponível: segue o navegador
  }
  return navigator.language.toLowerCase().startsWith('pt') ? 'pt' : 'en'
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(initialLanguage)

  const setLanguage = useCallback((next: Language) => {
    setLanguageState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // preferência não persistida
    }
    document.documentElement.lang = next === 'pt' ? 'pt-BR' : 'en'
  }, [])

  const value = useMemo<I18nValue>(() => {
    const dictionary = messages[language]
    const t = (key: MessageKey, params: Record<string, string | number> = {}) =>
      dictionary[key].replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
    return {
      language,
      setLanguage,
      t,
      locale: language === 'pt' ? 'pt-BR' : 'en-US',
      has: (key: string): key is MessageKey => key in dictionary,
    }
  }, [language, setLanguage])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}
