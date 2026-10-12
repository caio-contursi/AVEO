import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nContext } from '../../i18n/context'
import { messages, type Language } from '../../i18n/messages'
import { StatusPage } from './StatusPage'

const mocks = vi.hoisted(() => ({ failed: false, rpcUrl: 'http://127.0.0.1:8899', read: vi.fn() }))
vi.mock('../../api/inventory', () => ({ readNetworkStatus: mocks.read, readAssets: mocks.read }))
vi.mock('@tanstack/react-query', () => ({ useQuery: ({ queryKey }: { queryKey: unknown[] }) => ({
  error: mocks.failed ? new Error('Offline') : undefined, isLoading: false, refetch: vi.fn(),
  data: queryKey[0] === 'network-status'
    ? { slot: 42, version: 'test', programs: [{ id: 'program', label: 'Hook', executable: true }] }
    : undefined,
}) }))
vi.mock('../../app/desk', () => ({ useDesk: () => ({
  env: { VITE_CLUSTER: 'localnet', VITE_RPC_URL: mocks.rpcUrl, VITE_BACKEND: 'aveo-sas-hook', VITE_DEPLOYMENT_URL: '/dev/deployment.json' },
  programId: 'program', commitment: 'confirmed', ctx: {}, deployment: { generatedAt: '2026-10-09T12:00:00Z' },
}) }))

function render(language: Language) {
  return renderToStaticMarkup(createElement(I18nContext.Provider, { value: {
    language, locale: language === 'en' ? 'en-US' : 'pt-BR', setLanguage: () => {},
    t: (key, params = {}) => messages[language][key].replace(/\{(\w+)\}/g,
      (match, name: string) => name in params ? String(params[name]) : match),
    has: (key): key is keyof typeof messages.en => key in messages.en,
  } }, createElement(StatusPage)))
}

beforeEach(() => { vi.clearAllMocks(); mocks.failed = false; mocks.rpcUrl = 'http://127.0.0.1:8899' })

describe.each(['en', 'pt'] as const)('network-first context page (%s)', (language) => {
  it('shows program observations before expandable configuration without automatic actions', () => {
    const html = render(language)
    expect(html.indexOf(`<h2>${messages[language]['status.network']}</h2>`)).toBeLessThan(html.indexOf('class="technical-details"'))
    expect(html).toContain(messages[language]['status.deployed'])
    expect(html).toContain('class="badge ok"')
    expect(html).toMatch(/<details class="technical-details"><summary>/)
    expect(html).not.toMatch(/<details[^>]*\bopen=/)
    expect(html).toContain('http://127.0.0.1:8899')
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it('keeps read errors visible without displaying cached programs as currently deployed', () => {
    mocks.failed = true
    const html = render(language)
    expect(html).toContain('role="alert"')
    expect(html).toContain('Offline')
    expect(html).not.toContain('class="badge ok"')
    expect(html).not.toContain(messages[language]['status.deployed'])
  })

  it('shows only the RPC origin, never endpoint credentials or query tokens', () => {
    mocks.rpcUrl = 'https://private-user:private-password@rpc.invalid:8443/private-path?api-key=private-token#private-fragment'
    const html = render(language)
    expect(html).toContain('https://rpc.invalid:8443')
    expect(html).toContain(messages[language]['ux.rpcOrigin'])
    expect(html).not.toMatch(/private-user|private-password|private-path|private-token|private-fragment/)
  })

  it.each(['invalid-private-token', 'javascript:private-token'])('does not leak an invalid or non-HTTP endpoint: %s', (value) => {
    mocks.rpcUrl = value
    expect(render(language)).not.toContain('private-token')
  })
})
