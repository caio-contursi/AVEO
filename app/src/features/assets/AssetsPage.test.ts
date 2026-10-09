import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nContext } from '../../i18n/context'
import { messages, type Language } from '../../i18n/messages'
import { AssetsPage } from './AssetsPage'

const mocks = vi.hoisted(() => ({ failed: false, unknown: false, cached: false, fetching: false, inspect: vi.fn(), send: vi.fn() }))
vi.mock('../../app/desk', () => ({ useReadyDesk: () => ({
  backend: { inspect: mocks.inspect, planTransfer: mocks.send },
  deployment: {
    assets: [{ id: 'asset', mint: 'mint', label: 'Asset', symbol: 'ASSET', decimals: 0 }],
    wallets: [{ address: 'wallet', label: 'Investor', role: 'investor' }],
  },
}) }))
vi.mock('./queries', () => ({
  useAssetsQuery: () => ({ data: { assets: [{ asset: { mint: 'mint' } }] }, refetch: vi.fn() }),
  useHoldingsQuery: () => ({ data: { holdings: [] } }),
  useInspectQueries: () => [{
    error: mocks.failed ? new Error('Offline') : undefined,
    isFetching: mocks.fetching,
    data: mocks.cached ? { verdict: 'eligible', reasons: [], wallet: 'wallet', mint: 'mint' }
      : mocks.unknown ? { verdict: 'unknown', reasons: [], wallet: 'wallet', mint: 'mint' } : undefined,
  }],
}))
vi.mock('./PolicyCard', () => ({ PolicyCard: () => 'POLICY_CONTROLS' }))
vi.mock('./ProofsTable', () => ({ ProofsTable: () => 'PROOF_CONTROLS' }))

function render(language: Language) {
  return renderToStaticMarkup(createElement(I18nContext.Provider, { value: {
    language, locale: language === 'en' ? 'en-US' : 'pt-BR', setLanguage: () => {},
    t: (key) => messages[language][key],
    has: (key): key is keyof typeof messages.en => key in messages.en,
  } }, createElement(MemoryRouter, null, createElement(AssetsPage))))
}

beforeEach(() => { vi.clearAllMocks(); mocks.failed = false; mocks.unknown = false; mocks.cached = false; mocks.fetching = false })

describe.each(['en', 'pt'] as const)('eligibility-first page (%s)', (language) => {
  it('puts inspection before configuration and offers navigation rather than automatic actions', () => {
    const html = render(language)
    expect(html.indexOf('class="matrix"')).toBeLessThan(html.indexOf('class="technical-details"'))
    expect(html).toContain(messages[language]['ux.inspectFirst'])
    expect(html).toContain(`<a class="section-link" href="/transferencia"`)
    expect(html).toContain(`<a class="section-link" href="/incidentes"`)
    expect(html).toContain(messages[language]['ux.continueTransfer'])
    expect(html).toContain(messages[language]['ux.continueIncidents'])
    expect(html).toMatch(/<details class="technical-details"><summary>/)
    expect(html).not.toMatch(/<details[^>]*\bopen=/)
    expect(html).toContain('POLICY_CONTROLS')
    expect(html).toContain('PROOF_CONTROLS')
    expect(mocks.inspect).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it.each(['failed', 'unknown'] as const)('keeps unreadable eligibility neutral instead of displaying an approval: %s', (state) => {
    mocks[state] = true
    const html = render(language)
    expect(html).toContain('class="badge unknown"')
    expect(html).toContain(messages[language]['verdict.unknown'])
    expect(html).not.toContain('class="badge ok"')
  })

  it.each(['failed', 'fetching'] as const)('does not show cached eligible data as a current decision during %s', (state) => {
    mocks.cached = true
    mocks[state] = true
    const html = render(language)
    expect(html).not.toContain('class="badge ok"')
    expect(html).not.toContain(messages[language]['verdict.eligible'])
  })
})
