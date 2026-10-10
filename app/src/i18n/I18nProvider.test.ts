import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useI18n, type I18nValue } from './context'
import { I18nProvider } from './I18nProvider'
import { messages, type Language } from './messages'

const mocks = vi.hoisted(() => ({
  language: undefined as Language | undefined,
  effects: [] as Array<() => void>,
  value: undefined as I18nValue | undefined,
}))

// Follow the existing SSR harness: retain state across renders and flush effects explicitly.
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>()
  return {
    ...actual,
    useState: (initial: () => Language) => {
      mocks.language ??= initial()
      return [mocks.language, (next: Language) => { mocks.language = next }]
    },
    useEffect: (effect: () => void) => { mocks.effects.push(effect) },
  }
})

const getItem = vi.fn<() => string | null>()
const setItem = vi.fn<(key: string, value: string) => void>()

function Consumer() {
  const value = useI18n()
  mocks.value = value
  return createElement('span', { lang: value.locale }, value.t('ux.navigation'))
}

function render() {
  mocks.effects = []
  const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(Consumer)))
  mocks.effects.forEach((effect) => effect())
  return html
}

function expectLanguage(language: Language, html: string) {
  expect(mocks.value?.language).toBe(language)
  expect(mocks.value?.locale).toBe(language === 'pt' ? 'pt-BR' : 'en-US')
  expect(html).toContain(messages[language]['ux.navigation'])
  expect(document.documentElement.lang).toBe(language === 'pt' ? 'pt-BR' : 'en')
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.language = undefined
  mocks.value = undefined
  mocks.effects = []
  getItem.mockReturnValue(null)
  vi.stubGlobal('localStorage', { getItem, setItem })
  vi.stubGlobal('navigator', { language: 'en-US' })
  vi.stubGlobal('document', { documentElement: { lang: 'pt-BR' } })
})

afterEach(() => vi.unstubAllGlobals())

describe('document language synchronization', () => {
  it.each([
    ['en-US', 'en'],
    ['pt-BR', 'pt'],
    ['PT-pt', 'pt'],
    ['fr-FR', 'en'],
  ] as const)('synchronizes the initial browser language %s to %s', (browser, language) => {
    vi.stubGlobal('navigator', { language: browser })
    document.documentElement.lang = language === 'pt' ? 'en' : 'pt-BR'
    expectLanguage(language, render())
    expect(getItem).toHaveBeenCalledExactlyOnceWith('aveo.language')
    expect(setItem).not.toHaveBeenCalled()
  })

  it.each([
    ['en', 'pt-BR'],
    ['pt', 'en-US'],
  ] as const)('restores saved %s over browser language %s', (language, browser) => {
    getItem.mockReturnValue(language)
    vi.stubGlobal('navigator', { language: browser })
    document.documentElement.lang = language === 'pt' ? 'en' : 'pt-BR'
    expectLanguage(language, render())
    expect(setItem).not.toHaveBeenCalled()
  })

  it.each([
    ['en-US', 'en'],
    ['pt-PT', 'pt'],
  ] as const)('ignores an invalid saved language and falls back to %s', (browser, language) => {
    getItem.mockReturnValue('es')
    vi.stubGlobal('navigator', { language: browser })
    expectLanguage(language, render())
  })

  it.each([
    ['en-US', 'en'],
    ['pt-BR', 'pt'],
  ] as const)('falls back to %s when storage reads fail', (browser, language) => {
    getItem.mockImplementation(() => { throw new Error('Storage unavailable') })
    vi.stubGlobal('navigator', { language: browser })
    expectLanguage(language, render())
  })

  it('falls back to the browser when localStorage is absent', () => {
    vi.stubGlobal('localStorage', undefined)
    expectLanguage('en', render())
  })

  it.each(['en', 'pt'] as const)('switches from %s, persists, and restores on remount', (initial) => {
    const next = initial === 'en' ? 'pt' : 'en'
    getItem.mockReturnValue(initial)
    setItem.mockImplementation((_key, language) => { getItem.mockReturnValue(language) })
    expectLanguage(initial, render())
    mocks.value!.setLanguage(next)
    expectLanguage(next, render())
    expect(setItem).toHaveBeenCalledExactlyOnceWith('aveo.language', next)
    expect(getItem).toHaveBeenCalledTimes(1)

    mocks.language = undefined
    expectLanguage(next, render())
    expect(getItem).toHaveBeenCalledTimes(2)
    expect(setItem).toHaveBeenCalledTimes(1)
  })

  it('keeps translations and document language synchronized when storage writes fail', () => {
    setItem.mockImplementation(() => { throw new Error('Storage unavailable') })
    expectLanguage('en', render())
    mocks.value!.setLanguage('pt')
    expectLanguage('pt', render())
    mocks.value!.setLanguage('en')
    expectLanguage('en', render())
    expect(setItem.mock.calls).toEqual([['aveo.language', 'pt'], ['aveo.language', 'en']])
  })
})
