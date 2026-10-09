import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nContext } from '../../i18n/context'
import { messages, type Language } from '../../i18n/messages'
import { AssetsPage } from './AssetsPage'

const mocks = vi.hoisted(() => ({ failed: false, unknown: false, cached: false, fetching: false,
  holdingsFailed: false, holdingsFetching: false, refetch: vi.fn(), retry: undefined as (() => void) | undefined,
  inspect: vi.fn(), send: vi.fn() }))
vi.mock('react/jsx-dev-runtime', async (original) => {
  const actual = await original<typeof import('react/jsx-dev-runtime')>()
  return { ...actual, jsxDEV: (...args: Parameters<typeof actual.jsxDEV>) => {
    const props = args[1] as { className?: string; onClick?: () => void }
    if (args[0] === 'button' && !props.className && props.onClick) mocks.retry = props.onClick
    return actual.jsxDEV(...args)
  } }
})
vi.mock('../../app/desk', () => ({ useReadyDesk: () => ({
  backend: { inspect: mocks.inspect, planTransfer: mocks.send },
  deployment: {
    assets: [{ id: 'asset', mint: 'mint', label: 'Asset', symbol: 'ASSET', decimals: 0 }],
    wallets: [{ address: 'wallet', label: 'Investor', role: 'investor' }],
  },
}) }))
vi.mock('./queries', () => ({
  useAssetsQuery: () => ({ data: { assets: [{ asset: { mint: 'mint' } }] }, refetch: vi.fn() }),
  useHoldingsQuery: () => ({ error: mocks.holdingsFailed ? new Error('Offline') : undefined, isFetching: mocks.holdingsFetching,
    data: { holdings: [{ mint: 'mint', wallet: 'wallet', amount: 7n }] } }),
  useInspectQueries: () => [{
    error: mocks.failed ? new Error('Offline') : undefined,
    isFetching: mocks.fetching,
    refetch: mocks.refetch,
    data: mocks.cached ? { verdict: 'eligible', reasons: [], wallet: 'wallet', mint: 'mint' }
      : mocks.unknown ? { verdict: 'unknown', reasons: [], wallet: 'wallet', mint: 'mint' } : undefined,
  }],
}))
vi.mock('./PolicyCard', () => ({ PolicyCard: () => 'POLICY_CONTROLS' }))
vi.mock('./ProofsTable', () => ({ ProofsTable: () => 'PROOF_CONTROLS' }))

function render(language: Language) {
  return renderToStaticMarkup(createElement(I18nContext.Provider, { value: {
    language, locale: language === 'en' ? 'en-US' : 'pt-BR', setLanguage: () => {},
    t: (key, params = {}) => messages[language][key].replace(/\{(\w+)\}/g,
      (match, name: string) => name in params ? String(params[name]) : match),
    has: (key): key is keyof typeof messages.en => key in messages.en,
  } }, createElement(MemoryRouter, null, createElement(AssetsPage))))
}

beforeEach(() => { vi.clearAllMocks(); mocks.failed = false; mocks.unknown = false; mocks.cached = false; mocks.fetching = false
  mocks.holdingsFailed = false; mocks.holdingsFetching = false; mocks.retry = undefined })

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

  it('names a diagnosis control with its wallet, asset and observed verdict', () => {
    mocks.cached = true
    const html = render(language)
    expect(html).toContain(messages[language]['ux.inspectCell'].replace('{wallet}', 'Investor').replace('{asset}', 'Asset').replace('{verdict}', messages[language]['verdict.eligible']))
    expect(html).toContain('<th scope="row"><strong>Investor</strong></th>')
    expect(html).toContain('<th scope="col">Asset</th>')
    expect(html).toContain(`<caption class="sr-only">${messages[language]['assets.matrix']}</caption>`)
  })

  it('offers an explicit read-only retry instead of leaving a failed matrix silently unknown', () => {
    mocks.failed = true
    const html = render(language)
    expect(html).toContain(messages[language]['ux.inspectUnavailable'])
    expect(html.indexOf(messages[language]['ux.inspectUnavailable'])).toBeLessThan(html.indexOf('class="technical-details"'))
    expect(html).toContain('role="alert"')
    expect(mocks.refetch).not.toHaveBeenCalled()
    expect(mocks.retry).toBeTypeOf('function')
    mocks.retry!()
    expect(mocks.refetch).toHaveBeenCalledOnce()
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('shows loading text only during an actual read and keeps idle missing data unknown', () => {
    expect(render(language)).not.toContain(messages[language]['state.loading'])
    mocks.fetching = true
    const html = render(language)
    expect(html).toContain(messages[language]['state.loading'])
    expect(html).not.toContain('>…<')
  })

  it('does not offer an empty diagnosis control without a readable snapshot', () => {
    expect(render(language)).toContain('class="cell " disabled=""')
    mocks.cached = true
    expect(render(language)).not.toContain('class="cell " disabled=""')
  })

  it.each(['holdingsFailed', 'holdingsFetching'] as const)('does not show cached balances during %s', (state) => {
    expect(render(language)).toContain('7 ASSET')
    mocks[state] = true
    expect(render(language)).not.toContain('7 ASSET')
  })
})
