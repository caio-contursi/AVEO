import { readFileSync } from 'node:fs'
import type { Signature } from '@solana/kit'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nContext } from '../../i18n/context'
import { messages, type Language } from '../../i18n/messages'
import { DemoPage } from './DemoPage'
import { DEMO_SCENES, type DemoEvidence, type DemoTransactionResult } from './evidence'

const mocks = vi.hoisted(() => ({
  cluster: 'localnet', program: 'program', generatedAt: '2026-10-10T12:00:00Z',
  url: '/fixtures/deployment.json?private-token=secret',
  evidence: { data: undefined as DemoEvidence | undefined, isPending: false, fetchStatus: 'idle', isError: false, isFetching: false, dataUpdatedAt: 1, refetch: vi.fn() },
  verification: { data: undefined as DemoTransactionResult[] | undefined, fetchStatus: 'idle', isError: false, isFetching: false, refetch: vi.fn() },
  options: [] as { queryKey: unknown[]; queryFn: (context: { signal: AbortSignal }) => unknown; enabled: boolean; retry: boolean; refetchOnWindowFocus: boolean; refetchOnReconnect?: boolean }[],
  buttons: [] as { children: string; disabled: boolean; onClick: () => void }[],
  fetch: vi.fn(), verify: vi.fn(),
}))

vi.mock('react/jsx-dev-runtime', async (original) => {
  const actual = await original<typeof import('react/jsx-dev-runtime')>()
  return { ...actual, jsxDEV: (...args: Parameters<typeof actual.jsxDEV>) => {
    if (args[0] === 'button') mocks.buttons.push(args[1] as typeof mocks.buttons[number])
    return actual.jsxDEV(...args)
  } }
})
vi.mock('@tanstack/react-query', () => ({ useQuery: (options: typeof mocks.options[number]) => {
  mocks.options.push(options)
  return options.queryKey[0] === 'demo-evidence' ? mocks.evidence : mocks.verification
} }))
vi.mock('./evidence', async (original) => {
  const actual = await original<typeof import('./evidence')>()
  return { ...actual, fetchDemoEvidence: mocks.fetch, verifyDemoTransactions: mocks.verify }
})
vi.mock('../../app/desk', () => ({ useReadyDesk: () => ({
  env: { VITE_CLUSTER: mocks.cluster, VITE_DEPLOYMENT_URL: mocks.url }, programId: mocks.program,
  ctx: { cluster: mocks.cluster, rpcUrl: 'https://rpc.invalid/private-token', commitment: 'confirmed' },
  deployment: { generatedAt: mocks.generatedAt },
}) }))

function bundle(): DemoEvidence {
  // Rendering fixture only: production records are checked by the evidence parser.
  return {
    version: 1, scope: 'localnet-synthetic', genesisHash: 'genesis' as DemoEvidence['genesisHash'], programId: 'program' as DemoEvidence['programId'],
    deploymentGeneratedAt: mocks.generatedAt, completedAt: '2026-10-10T13:00:00Z', assets: [], wallets: [],
    scenes: DEMO_SCENES.map((scene) => ({ id: scene.id, stages: [{
      id: scene.stageIds[0], status: 'PASS' as const, evidence: [{
        signature: `signature-${scene.id}` as Signature, slot: 123, status: 'failed' as const, hookCode: 'AttestationExpired' as const,
        before: ['100', '0'], after: ['100', '0'],
      }],
    }] })),
  }
}

function render(language: Language = 'en') {
  mocks.buttons = []
  mocks.options = []
  return renderToStaticMarkup(createElement(I18nContext.Provider, { value: {
    language, locale: language === 'en' ? 'en-US' : 'pt-BR', setLanguage: vi.fn(),
    t: (key, params = {}) => messages[language][key].replace(/\{(\w+)\}/g,
      (match, name: string) => name in params ? String(params[name]) : match),
    has: (key): key is keyof typeof messages.en => key in messages[language],
  } }, createElement(MemoryRouter, null, createElement(DemoPage))))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', { location: { href: 'http://localhost:5173/#/demonstracao' } })
  mocks.cluster = 'localnet'; mocks.program = 'program'; mocks.generatedAt = '2026-10-10T12:00:00Z'
  mocks.url = '/fixtures/deployment.json?private-token=secret'
  mocks.evidence = { data: undefined, isPending: false, fetchStatus: 'idle', isFetching: false, isError: false, dataUpdatedAt: 1, refetch: vi.fn() }
  mocks.verification = { data: undefined, fetchStatus: 'idle', isFetching: false, isError: false, refetch: vi.fn() }
})

afterEach(() => vi.unstubAllGlobals())

describe.each(['en', 'pt'] as const)('guided demonstration (%s)', (language) => {
  it('explains six numbered scenarios with existing operational links', () => {
    const html = render(language)
    for (const scene of DEMO_SCENES) expect(html).toContain(messages[language][`demo.${scene.id}.title`])
    expect(html.match(/class="card demo-scene"/g)).toHaveLength(6)
    for (const path of ['carteiras', 'transferencia', 'incidentes', 'recibos']) expect(html).toContain(`href="/${path}"`)
    for (const key of ['demo.problem', 'demo.scope', 'demo.history', 'demo.readClaims', 'demo.separate'] as const) {
      expect(html).toContain(messages[language][key].replaceAll('&', '&amp;'))
    }
    expect(html).not.toContain('class="badge ok"')
    expect(html).not.toContain('private-token')
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(mocks.verify).not.toHaveBeenCalled()
  })

  it('keeps the entry concise and puts technical limitations in a closed disclosure', () => {
    mocks.evidence.data = bundle()
    const html = render(language)
    const detailStart = html.indexOf('<details class="demo-details">')
    const detailEnd = html.indexOf('</details>', detailStart)
    for (const key of ['demo.history', 'demo.scope', 'demo.recheck', 'demo.recheckNote'] as const) {
      expect(html.indexOf(messages[language][key].replaceAll('&', '&amp;'))).toBeLessThan(detailStart)
    }
    for (const key of ['demo.readClaims', 'demo.separate'] as const) {
      const position = html.indexOf(messages[language][key])
      expect(position).toBeGreaterThan(detailStart)
      expect(position).toBeLessThan(detailEnd)
    }
    expect(html).not.toMatch(/<details[^>]*\bopen=/)
    expect(messages[language]['demo.scope']).not.toMatch(/Route B|Rota B/)
    expect(html).toContain(messages[language]['demo.outside.body'])
    expect(html).toContain(messages[language]['demo.invalidation.body'])
  })

  it('shows empty and not-run states without a success signal', () => {
    const html = render(language)
    expect(html).toContain(messages[language]['demo.empty'])
    expect(html.split(messages[language]['demo.notRun'])).toHaveLength(7)
    expect(mocks.buttons.find((button) => button.children === messages[language]['demo.recheck'])?.disabled).toBe(true)
  })

  it('shows loading without inventing scenario evidence', () => {
    mocks.evidence.isFetching = true
    const html = render(language)
    expect(html).toContain(messages[language]['demo.loading'])
    expect(html).toContain(messages[language]['demo.notRun'])
    expect(html).not.toContain('class="badge ok"')
  })

  it('keeps missing, malformed and deployment-mismatch failures visible with a read-only retry', () => {
    mocks.evidence.isError = true
    const html = render(language)
    expect(html).toContain('role="alert"')
    expect(html).toContain(messages[language]['demo.failed'])
    expect(html).toContain(messages[language]['demo.evidenceHelp'])
    const retry = mocks.buttons.find((button) => button.children === messages[language]['state.retry'])!
    retry.onClick()
    expect(mocks.evidence.refetch).toHaveBeenCalledOnce()
    expect(mocks.verify).not.toHaveBeenCalled()
    expect(html).not.toContain('class="badge ok"')
  })

  it('treats file PASS as neutral and explains saved rejected transactions', () => {
    mocks.evidence.data = bundle()
    const html = render(language)
    expect(html).toContain(messages[language]['demo.recorded'])
    expect(html).not.toContain('class="badge ok"')
    expect(html).not.toContain('PASS')
    expect(html).toContain('signature-invalidation')
    expect(html).toContain('123')
    expect(html).toContain(messages[language]['reason.AttestationExpired'])
    expect(html).toContain(messages[language]['demo.reason'])
    expect(html).toContain(messages[language]['evidence.before'])
    expect(html).toMatch(/<details class="demo-details"><summary>/)
    expect(html).not.toMatch(/<details[^>]*\bopen=/)
    expect(html).not.toContain('{&quot;')
  })

  it('queries only after the explicit click and displays ledger verification narrowly', async () => {
    mocks.evidence.data = bundle()
    render(language)
    expect(mocks.options[1].enabled).toBe(false)
    const button = mocks.buttons.find((button) => button.children === messages[language]['demo.recheck'])!
    expect(button.disabled).toBe(false)
    button.onClick()
    expect(mocks.verification.refetch).toHaveBeenCalledOnce()
    const signal = new AbortController().signal
    await mocks.options[1].queryFn({ signal })
    expect(mocks.verify).toHaveBeenCalledWith(expect.objectContaining({ cluster: 'localnet' }), mocks.evidence.data, signal)
    mocks.verification.data = [{ signature: 'signature-reuse', status: 'verified', slot: 123 }]
    const html = render(language)
    expect(html).toContain(messages[language]['demo.verified'])
    expect(html).toContain(messages[language]['demo.checked'])
    expect(html).toContain(messages[language]['demo.readClaims'])
    expect(html).not.toContain('PASS')
  })

  it.each(['refresh', 'failure'] as const)('suppresses cached green verification during %s', (state) => {
    mocks.evidence.data = bundle()
    mocks.verification.data = [{ signature: 'signature-reuse', status: 'verified', slot: 123 }]
    mocks.verification.isFetching = state === 'refresh'; mocks.verification.isError = state === 'failure'
    const html = render(language)
    expect(html).not.toContain('class="badge ok"')
    expect(html).toContain(messages[language][state === 'refresh' ? 'demo.rechecking' : 'demo.recheckFailed'])
    expect(html).toContain('signature-reuse')
  })

  it.each(['refresh', 'failure'] as const)('suppresses cached green verification while evidence is in %s', (state) => {
    mocks.evidence.data = bundle()
    mocks.verification.data = [{ signature: 'signature-reuse', status: 'verified', slot: 123 }]
    mocks.evidence.isFetching = state === 'refresh'; mocks.evidence.isError = state === 'failure'
    const html = render(language)
    expect(html).not.toContain('class="badge ok"')
    expect(html).toContain(messages[language][state === 'refresh' ? 'demo.loading' : 'demo.failed'])
    expect(html).toContain('signature-reuse')
  })

  it.each(['unavailable', 'mismatch'] as const)('keeps %s results visible outside collapsed details', (status) => {
    mocks.evidence.data = bundle()
    mocks.verification.data = [{ signature: 'signature-reuse', status, slot: 123 }]
    const html = render(language)
    expect(html).toContain(messages[language][`demo.${status}`])
    expect(html.indexOf(messages[language][`demo.${status}`])).toBeLessThan(html.indexOf(messages[language]['demo.details']))
    expect(html).not.toContain('class="badge ok"')
    expect(html).not.toContain(messages[language]['demo.verified'])
  })

  it('keeps paused initial evidence reads visibly pending', () => {
    mocks.evidence.isPending = true; mocks.evidence.fetchStatus = 'paused'
    const html = render(language)
    expect(html).toContain(messages[language]['demo.loading'])
    expect(html).not.toContain(messages[language]['demo.empty'])
  })

  it('suppresses old verified results while the ledger request is paused', () => {
    mocks.evidence.data = bundle()
    mocks.verification.data = [{ signature: 'signature-reuse', status: 'verified' }]
    mocks.verification.fetchStatus = 'paused'
    const html = render(language)
    expect(html).toContain(messages[language]['demo.rechecking'])
    expect(html).not.toContain('class="badge ok"')
  })

  it('keeps empty ledger responses unavailable instead of implying success', () => {
    mocks.evidence.data = bundle(); mocks.verification.data = []
    const html = render(language)
    expect(html).toContain(messages[language]['demo.unavailable'])
    expect(html).not.toContain('class="badge ok"')
  })

  it('shows unique ledger counts and retry guidance above collapsed scene details', () => {
    mocks.evidence.data = bundle()
    const duplicate = mocks.evidence.data.scenes[0]!.stages[0]!.evidence[0]!
    mocks.evidence.data.scenes[5]!.stages.push({ id: 'fresh-readback', status: 'PASS', evidence: [duplicate] })
    mocks.verification.data = [
      { signature: 'signature-reuse', status: 'verified' },
      { signature: 'signature-policies', status: 'mismatch' },
      ...['outside', 'invalidation', 'impact', 'renewal'].map((id) => ({ signature: `signature-${id}`, status: 'unavailable' as const })),
    ]
    const html = render(language)
    const summary = messages[language]['demo.summary'].replace('{verified}', '1').replace('{unavailable}', '4').replace('{mismatch}', '1')
    expect(html).toContain(`<p role="status">${summary}</p>`)
    expect(html.indexOf(summary)).toBeLessThan(html.indexOf(messages[language]['demo.details']))
    expect(html).toContain(messages[language]['demo.unavailableHelp'])
    expect(html).toContain(`<p role="alert">${messages[language]['demo.mismatchHelp']}</p>`)
    expect(mocks.buttons.find((button) => button.children === messages[language]['demo.recheck'])?.disabled).toBe(false)
    expect(html).not.toContain('PASS')
  })

  it.each(['ledger-refresh', 'ledger-paused', 'evidence-refresh', 'error'] as const)('hides stale summary counts during %s', (state) => {
    mocks.evidence.data = bundle()
    mocks.verification.data = [{ signature: 'signature-reuse', status: 'verified' }]
    if (state === 'ledger-refresh') mocks.verification.isFetching = true
    if (state === 'ledger-paused') mocks.verification.fetchStatus = 'paused'
    if (state === 'evidence-refresh') mocks.evidence.isFetching = true
    if (state === 'error') mocks.verification.isError = true
    const html = render(language)
    expect(html).not.toContain('class="demo-ledger-summary"')
    expect(html).not.toContain(messages[language]['demo.unavailableHelp'])
    expect(html).not.toContain('class="badge ok"')
    expect(html).toContain(messages[language][state === 'error' ? 'demo.recheckFailed' : state === 'evidence-refresh' ? 'demo.loading' : 'demo.rechecking'])
  })

  it('offers devnet guidance without fetching or showing localnet results', () => {
    mocks.cluster = 'devnet'; mocks.evidence.data = bundle()
    mocks.verification.data = [{ signature: 'signature-reuse', status: 'verified' }]
    const html = render(language)
    expect(html).toContain(messages[language]['demo.localOnly'])
    expect(mocks.options.every((query) => !query.enabled)).toBe(true)
    expect(html).not.toContain('signature-reuse')
    expect(html).not.toContain('class="badge ok"')
    expect(mocks.buttons).toHaveLength(0)
  })
})

describe('read context and entry routing', () => {
  it('fetches a sibling evidence URL without propagating manifest secrets, with an abort signal', async () => {
    render()
    const signal = new AbortController().signal
    await mocks.options[0].queryFn({ signal })
    expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith('http://localhost:5173/fixtures/judge-evidence.json', expect.any(Object), signal)
  })

  it('uses separate query contexts for deployment, program, genesis and refreshed evidence', () => {
    mocks.evidence.data = bundle(); render()
    const original = mocks.options.map((query) => query.queryKey)
    mocks.program = 'another-program'; mocks.generatedAt = '2026-10-11T12:00:00Z'
    mocks.url = '/other/deployment.json'; mocks.evidence.data.genesisHash = 'another-genesis' as DemoEvidence['genesisHash']
    mocks.evidence.dataUpdatedAt = 2; render()
    expect(mocks.options[0].queryKey).not.toEqual(original[0])
    expect(mocks.options[1].queryKey).not.toEqual(original[1])
    expect(mocks.options[1].queryKey).toContain('another-genesis')
    expect(mocks.options.every((query) => query.retry === false && query.refetchOnWindowFocus === false)).toBe(true)
    expect(mocks.options[1].refetchOnReconnect).toBe(false)
  })

  it('requires deployment for the demonstration and preserves the operational paths', () => {
    const routes = readFileSync(new URL('../../app/routes.tsx', import.meta.url), 'utf8')
    const app = readFileSync(new URL('../../app/App.tsx', import.meta.url), 'utf8')
    expect(routes).toMatch(/path: 'demonstracao', element: <RequireDeployment><DemoPage \/><\/RequireDeployment>/)
    for (const path of ['carteiras', 'transferencia', 'incidentes', 'recibos', 'rede']) expect(routes).toContain(`path: '${path}'`)
    expect(app.match(/<Navigate to="\/demonstracao" replace \/>/g)).toHaveLength(2)
  })
})
