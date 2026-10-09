import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nContext } from '../../i18n/context'
import { messages, type Language } from '../../i18n/messages'
import { IncidentsPage } from './IncidentsPage'

const mocks = vi.hoisted(() => ({
  lastScan: undefined as { slot: number; at: string } | undefined,
  inspect: vi.fn(), update: vi.fn(), invalidate: vi.fn(),
}))
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: mocks.invalidate }) }))
vi.mock('../../app/desk', () => ({ useReadyDesk: () => ({
  ctx: { cluster: 'localnet' }, backend: { inspect: mocks.inspect }, deployment: { assets: [], wallets: [] },
}) }))
vi.mock('./store', () => ({ useIncidentStore: () => ({
  data: { incidents: [], lastScan: mocks.lastScan }, update: mocks.update,
}) }))
vi.mock('./IncidentCard', () => ({ IncidentCard: () => null }))

function render(language: Language) {
  return renderToStaticMarkup(createElement(I18nContext.Provider, { value: {
    language, locale: language === 'en' ? 'en-US' : 'pt-BR', setLanguage: () => {},
    t: (key, params = {}) => messages[language][key].replace(/\{(\w+)\}/g,
      (match, name: string) => name in params ? String(params[name]) : match),
    has: (key): key is keyof typeof messages.en => key in messages.en,
  } }, createElement(IncidentsPage)))
}

beforeEach(() => { vi.clearAllMocks(); mocks.lastScan = undefined })

describe.each(['en', 'pt'] as const)('incident scan guidance (%s)', (language) => {
  it('does not present an unscanned empty list as a successful check', () => {
    const html = render(language)
    expect(html).toContain('role="note"')
    expect(html).toContain(messages[language]['ux.scanFirst'])
    expect(html).toContain(messages[language]['incidents.neverScanned'])
    expect(html).toContain(messages[language]['incidents.scan'])
    expect(mocks.inspect).not.toHaveBeenCalled()
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.invalidate).not.toHaveBeenCalled()
  })

  it('retains a recorded scan without claiming a new read or scanning automatically', () => {
    mocks.lastScan = { slot: 42, at: '2026-10-09T12:00:00Z' }
    const html = render(language)
    expect(html).not.toContain(messages[language]['ux.scanFirst'])
    expect(html).not.toContain(messages[language]['incidents.neverScanned'])
    expect(html).toContain('42')
    expect(html).toContain(messages[language]['incidents.mock'])
    expect(mocks.inspect).not.toHaveBeenCalled()
  })
})
