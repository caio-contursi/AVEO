import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nContext } from '../../i18n/context'
import { messages, type Language } from '../../i18n/messages'
import { AssetsPage } from './AssetsPage'

const mocks = vi.hoisted(() => ({ failed: false, unknown: false, cached: false, fetching: false,
  holdingsFailed: false, holdingsFetching: false, holdingsPartial: false, holdingsRefetch: vi.fn(), refetch: vi.fn(), retry: undefined as (() => void) | undefined,
  retries: [] as (() => void)[], inspect: vi.fn(), plan: vi.fn(), sign: vi.fn(), send: vi.fn() }))
vi.mock('react/jsx-dev-runtime', async (original) => {
  const actual = await original<typeof import('react/jsx-dev-runtime')>()
  return { ...actual, jsxDEV: (...args: Parameters<typeof actual.jsxDEV>) => {
    const props = args[1] as { className?: string; onClick?: () => void }
    if (args[0] === 'button' && !props.className && props.onClick) {
      mocks.retry = props.onClick
      mocks.retries.push(props.onClick)
    }
    return actual.jsxDEV(...args)
  } }
})
vi.mock('../../app/desk', () => ({ useReadyDesk: () => ({
  backend: { inspect: mocks.inspect, planTransfer: mocks.plan },
  ctx: { rpc: { sendTransaction: mocks.send } },
  deployment: {
    assets: [{ id: 'asset', mint: 'mint', label: 'Asset', symbol: 'ASSET', decimals: 0 }],
    wallets: [{ address: 'wallet', label: 'Investor', role: 'investor' }, { address: 'other', label: 'Other', role: 'investor' }],
  },
}) }))
vi.mock('../../wallet/context', () => ({ useWallet: () => ({ connected: {
  signer: { signTransactions: mocks.sign, signAndSendTransactions: mocks.send },
} }) }))
vi.mock('./queries', () => ({
  useAssetsQuery: () => ({ data: { assets: [{ asset: { mint: 'mint' } }] }, refetch: vi.fn() }),
  useHoldingsQuery: () => ({ error: mocks.holdingsFailed ? new Error('Private RPC provider failure') : undefined, isFetching: mocks.holdingsFetching,
    refetch: mocks.holdingsRefetch,
    data: { holdings: [{ mint: 'mint', wallet: 'wallet', amount: 7n }, mocks.holdingsPartial
      ? { mint: 'mint', wallet: 'other', error: 'ReadUnverifiable' }
      : { mint: 'mint', wallet: 'other', amount: 9n }] } }),
  useInspectQueries: () => ['wallet', 'other'].map((wallet) => ({
    error: mocks.failed ? new Error('Offline') : undefined,
    isFetching: mocks.fetching,
    refetch: mocks.refetch,
    data: mocks.cached ? { verdict: 'eligible', reasons: [], wallet, mint: 'mint' }
      : mocks.unknown ? { verdict: 'unknown', reasons: [], wallet, mint: 'mint' } : undefined,
  })),
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
  mocks.holdingsFailed = false; mocks.holdingsFetching = false; mocks.holdingsPartial = false; mocks.retry = undefined; mocks.retries = [] })

describe.each(['en', 'pt'] as const)('eligibility-first page (%s)', (language) => {
  it('preserves valid balances and labels only the invalid cell, with a read-only retry and recovery', () => {
    mocks.holdingsPartial = true
    mocks.cached = true
    const html = render(language)
    expect(html).toContain('7 ASSET')
    expect(html).not.toContain('9 ASSET')
    expect(html).not.toContain('0 ASSET')
    expect(html).toContain(messages[language]['ux.balancesPartial'])
    expect(html.split(messages[language]['ux.balanceUnavailable'])).toHaveLength(2)
    expect(html).toContain('class="badge ok"')
    expect(mocks.retries).toHaveLength(1)
    mocks.retry!()
    expect(mocks.holdingsRefetch).toHaveBeenCalledOnce()
    expect(mocks.refetch).not.toHaveBeenCalled()
    expect(mocks.inspect).not.toHaveBeenCalled()
    expect(mocks.plan).not.toHaveBeenCalled()
    expect(mocks.sign).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
    mocks.holdingsFetching = true
    const refreshing = render(language)
    expect(refreshing).not.toContain('7 ASSET')
    expect(refreshing).not.toContain(messages[language]['ux.balanceUnavailable'])
    expect(refreshing).not.toContain(messages[language]['ux.balancesPartial'])
    mocks.holdingsFetching = false
    mocks.holdingsPartial = false
    const recovered = render(language)
    expect(recovered).toContain('7 ASSET')
    expect(recovered).toContain('9 ASSET')
    expect(recovered).not.toContain(messages[language]['ux.balancesPartial'])
  })

  it.each(['holdingsFailed', 'holdingsFetching'] as const)('hides all partial cached balances during %s', (state) => {
    mocks.holdingsPartial = true
    mocks[state] = true
    const html = render(language)
    expect(html).not.toContain('7 ASSET')
    expect(html).not.toContain('9 ASSET')
    expect(html).not.toContain(messages[language]['ux.balanceUnavailable'])
    expect(html).not.toContain(messages[language]['ux.balancesPartial'])
  })
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
    expect(html).toContain(`role="region" aria-label="${messages[language]['assets.matrixScrollRegion']}"`)
    expect(html).not.toContain('tabindex="0"')
    // SSR cannot know layout: do not claim overflow before measuring it.
    expect(html).not.toContain(messages[language]['assets.matrixScrollHint'])
    expect(html).not.toContain('aria-describedby=')
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
    expect(mocks.refetch).toHaveBeenCalledTimes(2)
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
    mocks.cached = true
    expect(render(language)).toContain('7 ASSET')
    mocks[state] = true
    const html = render(language)
    expect(html).not.toContain('7 ASSET')
    expect(html).toContain('class="badge ok"')
    expect(html).toContain(messages[language]['verdict.eligible'])
    expect(html).not.toContain('class="cell " disabled=""')
    if (state === 'holdingsFetching') {
      expect(html).not.toContain(messages[language]['ux.balancesUnavailable'])
      expect(mocks.retries).toHaveLength(0)
    }
  })

  it.each([false, true])('retries only holdings with a static localized error (inspection failed: %s)', (inspectionFailed) => {
    mocks.cached = true
    mocks.holdingsFailed = true
    mocks.failed = inspectionFailed
    const html = render(language)
    const title = messages[language]['ux.balancesUnavailable']
    expect(html).toContain(`<div class="state error" role="alert"><strong>${title}</strong><button type="button">${messages[language]['state.retry']}</button></div>`)
    expect(html.indexOf(title)).toBeLessThan(html.indexOf('class="matrix"'))
    expect(html).not.toContain('Private RPC provider failure')
    expect(html).not.toContain('7 ASSET')
    expect(mocks.retries).toHaveLength(inspectionFailed ? 2 : 1)
    expect(mocks.holdingsRefetch).not.toHaveBeenCalled()
    mocks.retry!()
    expect(mocks.holdingsRefetch).toHaveBeenCalledOnce()
    expect(mocks.refetch).not.toHaveBeenCalled()
    expect(mocks.inspect).not.toHaveBeenCalled()
    expect(mocks.plan).not.toHaveBeenCalled()
    expect(mocks.sign).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
    const afterRetry = render(language)
    expect(afterRetry).toContain(inspectionFailed ? 'class="badge unknown"' : 'class="badge ok"')
    expect(afterRetry).toContain(messages[language][inspectionFailed ? 'verdict.unknown' : 'verdict.eligible'])
  })

  it('keeps the holdings error visible while retrying and hides it after recovery', () => {
    mocks.cached = true
    mocks.holdingsFailed = true
    mocks.holdingsFetching = true
    const html = render(language)
    expect(html).toContain(messages[language]['ux.balancesUnavailable'])
    expect(html).not.toContain('7 ASSET')
    expect(html).toContain('class="badge ok"')
    mocks.holdingsFailed = false
    mocks.holdingsFetching = false
    const recovered = render(language)
    expect(recovered).not.toContain(messages[language]['ux.balancesUnavailable'])
    expect(recovered).toContain('7 ASSET')
    expect(recovered).toContain('class="badge ok"')
  })
})
