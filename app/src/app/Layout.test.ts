import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nContext, type I18nValue } from '../i18n/context'
import { messages, type Language } from '../i18n/messages'
import { Layout } from './Layout'

const mocks = vi.hoisted(() => ({
  status: { data: undefined as { slot: number } | undefined, isError: false, isFetching: true },
  cluster: 'localnet',
  invalidateQueries: vi.fn(),
  query: vi.fn(),
  skip: undefined as (() => void) | undefined,
}))

// Capture the rendered control's handler without adding a production test export.
vi.mock('react/jsx-dev-runtime', async (original) => {
  const actual = await original<typeof import('react/jsx-dev-runtime')>()
  function capture(...args: Parameters<typeof actual.jsxDEV>) {
    const [type, props] = args
    if (type === 'button' && (props as { className?: string }).className === 'skip-link') {
      mocks.skip = (props as { onClick: () => void }).onClick
    }
    return actual.jsxDEV(...args)
  }
  return { ...actual, jsxDEV: capture }
})

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: unknown) => { mocks.query(options); return mocks.status },
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}))
vi.mock('./desk', () => ({ useDesk: () => ({
  rpcReader: {},
  env: { VITE_CLUSTER: mocks.cluster, VITE_RPC_URL: 'https://rpc.invalid/?api-key=private-secret' },
}) }))
vi.mock('../wallet/WalletMenu', () => ({
  WalletMenu: () => createElement('button', { type: 'button' }, 'Wallet control'),
}))

function render(path = '/carteiras', language: Language = 'en') {
  const value: I18nValue = {
    language, locale: language === 'en' ? 'en-US' : 'pt-BR', setLanguage: vi.fn(),
    t: (key) => messages[language][key],
    has: (key): key is keyof typeof messages.en => key in messages[language],
  }
  return renderToStaticMarkup(createElement(I18nContext.Provider, { value },
    createElement(MemoryRouter, { initialEntries: [path] },
      createElement(Routes, null,
        createElement(Route, { element: createElement(Layout) },
          createElement(Route, { path: '*', element: createElement('div', null, 'Route content') }),
        ),
      ),
    ),
  ))
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.status = { data: undefined, isError: false, isFetching: true }
  mocks.cluster = 'localnet'
  mocks.skip = undefined
})

afterEach(() => vi.unstubAllGlobals())

describe('accessible desk shell', () => {
  it.each(['en', 'pt'] as const)('places the demonstration first and uses its hero (%s)', (language) => {
    const html = render('/demonstracao', language)
    expect(html.indexOf('href="/demonstracao"')).toBeLessThan(html.indexOf('href="/carteiras"'))
    expect(html).toContain(messages[language]['nav.demo'])
    expect(html).toContain(`<h1>${messages[language]['demo.title']}</h1>`)
  })

  it.each([
    ['/demonstracao', 'demo.title', 'demo.description'],
    ['/carteiras', 'ux.assetsTitle', 'ux.assetsDescription'],
    ['/transferencia', 'ux.transferTitle', 'ux.transferDescription'],
    ['/incidentes', 'ux.incidentsTitle', 'ux.incidentsDescription'],
    ['/recibos', 'ux.receiptsTitle', 'ux.receiptsDescription'],
    ['/rede', 'ux.statusTitle', 'ux.statusDescription'],
  ] as const)('shows the route hero and active destination for %s', (path, title, description) => {
    const html = render(path)
    expect(html).toContain(`<h1>${messages.en[title]}</h1>`)
    expect(html).toContain(messages.en[description])
    expect(html.match(/<h1>/g)).toHaveLength(1)
    expect(html).toContain(`aria-current="page" class="active" href="${path}"`)
    expect(html).toContain('Route content')
    expect(html).toContain(messages.en['ux.eyebrow'])
  })

  it.each(['en', 'pt'] as const)('provides translated navigation, skip target and language state (%s)', (language) => {
    const html = render('/rede', language)
    expect(html).toContain(`aria-label="${messages[language]['ux.navigation']}"`)
    expect(html).toContain(`<button type="button" class="skip-link">${messages[language]['ux.skipToContent']}</button>`)
    expect(html).not.toContain('href="#desk-content"')
    expect(html).toContain('<main id="desk-content" tabindex="-1">')
    expect(html).toContain(`aria-pressed="true" lang="${language}"`)
    expect(html).toContain(`aria-pressed="false" lang="${language === 'en' ? 'pt' : 'en'}"`)
    expect(html).toContain('src="/favicon.svg" alt=""')
    expect(html).toContain('Wallet control')
    expect(html.match(/href="\/(demonstracao|carteiras|transferencia|incidentes|recibos|rede)"/g)).toHaveLength(6)
  })

  it('focuses main content without mutating the hash route', () => {
    render('/transferencia')
    const focus = vi.fn()
    const getElementById = vi.fn(() => ({ focus }))
    const location = { hash: '#/transferencia' }
    vi.stubGlobal('document', { getElementById, location })
    vi.stubGlobal('window', { location })
    expect(mocks.skip).toBeTypeOf('function')
    mocks.skip!()
    expect(getElementById).toHaveBeenCalledExactlyOnceWith('desk-content')
    expect(focus).toHaveBeenCalledOnce()
    expect(location.hash).toBe('#/transferencia')
  })

  it('safely handles a missing focus target', () => {
    render()
    vi.stubGlobal('document', { getElementById: () => null })
    expect(() => mocks.skip!()).not.toThrow()
  })

  it('preserves the synthetic banner and localnet context without disclosing the endpoint', () => {
    const html = render()
    expect(html).toContain(messages.en['app.syntheticBanner'])
    expect(html).toContain(messages.en['app.localnetNote'])
    expect(html).not.toContain('rpc.invalid')
    expect(html).not.toContain('private-secret')
    mocks.cluster = 'devnet'
    expect(render()).not.toContain(messages.en['app.localnetNote'])
  })

  it('keeps the original network query and polling interval', () => {
    render()
    expect(mocks.query).toHaveBeenCalledWith(expect.objectContaining({
      queryKey: ['network-status'], refetchInterval: 15_000, queryFn: expect.any(Function),
    }))
    expect(mocks.invalidateQueries).not.toHaveBeenCalled()
  })

  it('shows a neutral loading signal before a result or during a cached refresh', () => {
    expect(render()).toContain(messages.en['ux.networkLoading'])
    mocks.status.data = { slot: 123456 }
    const html = render()
    expect(html).toContain('data-status="pending"')
    expect(html).toContain(messages.en['ux.networkLoading'])
    expect(html).not.toContain('slot 123,456')
  })

  it('does not present a missing network result as healthy when fetching is paused', () => {
    mocks.status = { data: undefined, isError: false, isFetching: false }
    const html = render()
    expect(html).toContain('data-status="pending"')
    expect(html).toContain(messages.en['ux.networkLoading'])
    expect(html).not.toContain('data-status="current"')
  })

  it.each([undefined, { slot: 123456 }])('warns on failure even with cached data (%j)', (data) => {
    mocks.status = { data, isError: true, isFetching: false }
    const html = render()
    expect(html).toContain('role="status" data-status="blocked"')
    expect(html).toContain(messages.en['ux.networkUnavailable'])
    expect(html).not.toContain('slot 123,456')
    expect(html).not.toContain('data-status="current"')
  })

  it('shows the observed slot after a successful read without a compliance verdict', () => {
    mocks.status = { data: { slot: 123456 }, isError: false, isFetching: false }
    const html = render()
    expect(html).toContain('data-status="current"')
    expect(html).toContain('slot 123,456')
    expect(html).not.toContain('data-status="complete"')
  })

  it('does not announce the polling heartbeat over operation progress', () => {
    const html = render()
    expect(html).toMatch(/class="pill network-status" role="status" data-status="pending" aria-live="off"/)
  })
})

describe('shared CSS contracts', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')

  it('contains shrinking grid tracks and a one-column mobile fallback', () => {
    expect(css).toContain('minmax(min(100%, 300px), 1fr)')
    expect(css).toContain('minmax(min(100%, 280px), 1fr)')
    expect(css).toContain('.grid-2, .policy-grid { grid-template-columns: minmax(0, 1fr); }')
    expect(css).toContain('.decision-actions { flex-wrap: wrap; }')
  })

  it('presents the evidence badge and slot as a simple wrapping row', () => {
    const row = css.match(/\.actions\.evidence-summary \{([^}]*)\}/)?.[1]
    expect(row).toContain('display: flex')
    expect(row).toContain('flex-wrap: wrap')
    expect(row).toContain('margin: 0')
    expect(row).not.toMatch(/border|padding|background/)
    expect(css).not.toMatch(/\.evidence-summary \{\s*border/)
  })

  it('supports keyboard focus, touch controls and reduced motion', () => {
    for (const selector of ['textarea:focus-visible', 'summary:focus-visible', 'main:focus-visible', '.skip-link:focus']) {
      expect(css).toContain(selector)
    }
    expect(css).toContain('min-height: 44px')
    expect(css).toContain('prefers-reduced-motion: reduce')
    expect(css).toContain('animation: none !important')
  })

  it('keeps unknown and pending evidence visually distinct from confirmed completion', () => {
    expect(css).toMatch(/\.workflow-step\[data-status='unknown'\],[\s\S]*?border: 1px dashed var\(--unknown\);/)
    expect(css).toMatch(/\.workflow-step\[data-status='complete'\] \{[^}]*color: var\(--ok\);/)
    expect(css).toMatch(/\.network-status\[data-status='blocked'\] \{[^}]*color: var\(--warn\);/)
  })
})
