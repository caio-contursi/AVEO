import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeskPlan } from '../../api/backend'
import type { DeskIncident } from './model'
import { PlanPreparation } from '../operations/preparation'
import { messages, type Language } from '../../i18n/messages'
import { IncidentCard } from './IncidentCard'

type Review = { key: string; title: string; plan: DeskPlan }
const mocks = vi.hoisted(() => ({
  current: null as DeskIncident | null,
  prepareControl: null as PlanPreparation<Review[]> | null,
  verifyControl: null as PlanPreparation<unknown[]> | null,
  hookIndex: 0, stateIndex: 0,
  busy: undefined as 'sign' | 'verify' | undefined,
  cleanups: [] as (() => void)[],
  buttons: [] as { onClick: () => void; children: unknown; className?: string; disabled?: boolean }[],
  planRenewBinding: vi.fn(), inspect: vi.fn(), runPlan: vi.fn(), patch: vi.fn(), capture: vi.fn(), invalidate: vi.fn(),
  language: 'en' as Language, twoProofs: false, throwPatch: false,
  policyVersion: 1n,
}))

vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>()
  return { ...actual,
    useState: (initial: unknown) => {
      if (mocks.stateIndex++ === 0) return [mocks.busy, (value: typeof mocks.busy) => { mocks.busy = value }]
      return actual.useState(initial)
    },
    useLayoutEffect: (effect: () => (() => void) | void) => {
      const cleanup = effect()
      if (cleanup) mocks.cleanups.push(cleanup)
    },
  }
})
vi.mock('react/jsx-dev-runtime', async (original) => {
  const actual = await original<typeof import('react/jsx-dev-runtime')>()
  return { ...actual, jsxDEV: (...args: Parameters<typeof actual.jsxDEV>) => {
    if (args[0] === 'button') mocks.buttons.push(args[1] as typeof mocks.buttons[number])
    return actual.jsxDEV(...args)
  } }
})

const ctx = {
  cluster: 'localnet', rpcUrl: 'http://127.0.0.1:8899', programId: 'program', commitment: 'confirmed',
  deployment: {
    generatedAt: '2026-10-09T12:00:00.000Z', verifiers: [],
    assets: [{ mint: 'alfa', label: 'Alfa' }, { mint: 'beta', label: 'Beta' }],
    wallets: [{ id: 'X', address: 'wallet', label: 'Investor' }],
  },
}
vi.mock('../../app/desk', () => ({ useReadyDesk: () => ({ ctx, deployment: ctx.deployment,
  backend: { planRenewBinding: mocks.planRenewBinding, inspect: mocks.inspect },
}) }))
vi.mock('../../wallet/context', () => ({ useWallet: () => ({ connected: { address: 'wallet', signer: {} } }) }))
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: mocks.invalidate }) }))
vi.mock('./store', () => ({ useIncidentStore: () => ({ patch: mocks.patch }) }))
vi.mock('../../api/eligibility', () => ({ checkPayload: () => ({ reasons: [] }) }))
vi.mock('../assets/queries', () => ({
  useClockQuery: () => ({ isPending: false, data: { unix: 100 } }),
  useProofsQuery: () => ({ isPending: false, data: ['A', 'B'].map((id) => ({
    wallet: 'wallet', address: `proof-${id}`, boundTo: [],
    attestation: { credential: `credential-${id}`, schema: `schema-${id}`, expiry: 10000n },
  })) }),
  useAssetsQuery: () => ({ isPending: false, data: { assets: ['alfa', 'beta'].map((mint) => ({
    asset: { mint }, policy: { policyVersion: mocks.policyVersion, active: true, pairs: [{ credential: `credential-${mint === 'beta' && mocks.twoProofs ? 'B' : 'A'}`, schema: `schema-${mint === 'beta' && mocks.twoProofs ? 'B' : 'A'}` }] },
  })) } }),
}))
vi.mock('../operations/usePlanPreparation', () => ({ usePlanPreparation: (scope: readonly unknown[]) => {
  const control = mocks.hookIndex++ === 0 ? mocks.prepareControl! : mocks.verifyControl!
  const key = JSON.stringify(scope)
  control.setScope(key)
  return { ...control.state,
    prepare: (build: () => Promise<never>) => control.prepare(key, build),
    clear: () => control.clear(), isCurrent: (plan: never) => control.isCurrent(key, plan),
  }
} }))
vi.mock('../operations/useExecutePlan', () => ({ runPlan: mocks.runPlan }))
vi.mock('../operations/submission-journal', () => ({ getSubmissionJournal: () => ({ capture: mocks.capture }) }))
vi.mock('../operations/SimulationSummary', () => ({ SimulationSummary: () => createElement('div', null, 'review') }))
vi.mock('../operations/EvidenceView', () => ({ EvidenceView: () => null }))
vi.mock('../../components/Address', () => ({ Address: () => null }))
vi.mock('../../i18n/context', () => ({ useI18n: () => ({ locale: 'en-US',
  has: (key: string) => key in messages.en,
  t: (key: keyof typeof messages.en, params: Record<string, string | number> = {}) =>
    messages[mocks.language][key].replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match),
}) }))

function opened(): DeskIncident {
  return {
    id: 'incident', key: 'PROOF_EXPIRED|wallet|old-proof', type: 'PROOF_EXPIRED', state: 'open',
    wallet: 'wallet', proof: 'old-proof', affectedMints: ['alfa', 'beta'], observed: true,
    detectedAt: '2026-10-09T12:00:00.000Z', detectedSlot: 10,
    cause: { code: 'AttestationExpired', message: 'Expired' }, events: [], evidence: [],
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => { resolve = accept })
  return { promise, resolve }
}
function render() {
  mocks.buttons = []; mocks.hookIndex = 0; mocks.stateIndex = 0
  return renderToStaticMarkup(createElement(IncidentCard, { incident: mocks.current! }))
}
function button(label: string) {
  const found = mocks.buttons.find((item) => JSON.stringify(item.children).includes(label))
  expect(found).toBeDefined()
  return found!
}
async function prepare() {
  render(); button(messages.en['incidents.prepare']).onClick()
  await vi.waitFor(() => expect(mocks.current?.state).toBe('action-prepared'))
  render()
}
function leave() {
  mocks.cleanups.splice(0).forEach((cleanup) => cleanup())
  mocks.prepareControl!.deactivate(); mocks.verifyControl!.deactivate()
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.current = opened(); mocks.busy = undefined; mocks.twoProofs = false; mocks.throwPatch = false
  mocks.language = 'en'; mocks.cleanups = []
  mocks.policyVersion = 1n
  mocks.prepareControl = new PlanPreparation<Review[]>(() => {})
  mocks.verifyControl = new PlanPreparation<unknown[]>(() => {})
  mocks.patch.mockImplementation((_id: string, update: (incident: DeskIncident) => DeskIncident) => {
    mocks.current = update(mocks.current!)
    if (mocks.throwPatch) throw new Error('private listener failure')
  })
  mocks.planRenewBinding.mockResolvedValue({ simulation: { ok: true } })
  mocks.capture.mockResolvedValue(undefined)
  mocks.invalidate.mockResolvedValue(undefined)
  mocks.inspect.mockImplementation(async ({ mint }: { mint: string }) => ({
    mint, wallet: 'wallet', backend: 'aveo-sas-hook', verdict: 'eligible', reasons: [],
    read: { cluster: ctx.cluster, rpcUrl: ctx.rpcUrl, commitment: ctx.commitment, slot: 130 },
  }))
  mocks.runPlan.mockImplementation(async (_ctx, _backend, _signer, _plan, options) => {
    options.onSent('signature')
    return { signature: 'signature', evidence: { status: 'confirmed', signature: 'signature', slot: 120, logs: [] } }
  })
})

describe('grouped renewal integration with controlled lifecycle callbacks', () => {
  it('invalidates a prepared review after a policy version changes without serializing bigint directly', async () => {
    await prepare()
    mocks.policyVersion = 2n
    expect(() => render()).not.toThrow()
    expect(mocks.prepareControl?.state.plan).toBeUndefined()
    expect(mocks.runPlan).not.toHaveBeenCalled()
  })

  it('clears prepared review if marking the action encounters a throwing store listener', async () => {
    mocks.throwPatch = true
    render(); button(messages.en['incidents.prepare']).onClick()
    await vi.waitFor(() => expect(mocks.patch).toHaveBeenCalledOnce())
    expect(mocks.prepareControl?.state.plan).toBeUndefined()
    expect(mocks.runPlan).not.toHaveBeenCalled()
  })

  it('groups both assets into one proof request and keeps review after marking prepared', async () => {
    await prepare()
    expect(mocks.planRenewBinding).toHaveBeenCalledExactlyOnceWith({ cluster: 'localnet', mint: 'alfa', mints: ['alfa', 'beta'], wallet: 'wallet', attestation: 'proof-A' })
    expect(mocks.current?.events.at(-1)).toMatchObject({ kind: 'prepared', params: { n: '2' } })
    expect(mocks.prepareControl?.state.plan).toHaveLength(1)
    expect(mocks.runPlan).not.toHaveBeenCalled()
    expect(mocks.capture).not.toHaveBeenCalled()
  })

  it.each(['scope', 'unmount', 'incident'] as const)('does not mark an obsolete preparation after %s changes', async (change) => {
    const reply = deferred<DeskPlan>()
    mocks.planRenewBinding.mockReturnValue(reply.promise)
    render(); button(messages.en['incidents.prepare']).onClick()
    if (change === 'scope') mocks.prepareControl!.setScope('different-network')
    if (change === 'unmount') leave()
    if (change === 'incident') mocks.current = { ...mocks.current!, affectedMints: ['alfa', 'beta', 'gamma'] }
    reply.resolve({ simulation: { ok: true } } as DeskPlan)
    await vi.waitFor(() => expect(mocks.prepareControl!.state.planning).toBe(false))
    expect(mocks.current?.state).toBe('open')
    expect(mocks.current?.events).toHaveLength(0)
    expect(mocks.prepareControl?.state.plan).toBeUndefined()
  })

  it('records a returned signature immediately and synchronously blocks sign/sign and sign/verify', async () => {
    await prepare()
    const reply = deferred<unknown>()
    mocks.runPlan.mockImplementation((_ctx, _backend, _signer, _plan, options) => { options.onSent('original'); return reply.promise })
    const sign = mocks.buttons.find((item) => item.className === 'primary')!
    const verify = button(messages.en['incidents.verify'])
    sign.onClick(); sign.onClick(); verify.onClick()
    expect(mocks.runPlan).toHaveBeenCalledOnce()
    expect(mocks.inspect).not.toHaveBeenCalled()
    expect(mocks.current).toMatchObject({ state: 'awaiting-confirmation', evidence: [{ status: 'unknown', signature: 'original' }] })
    expect(mocks.capture).toHaveBeenCalledExactlyOnceWith(ctx, 'original')
    reply.resolve({ signature: 'original', evidence: { status: 'confirmed', signature: 'original', slot: 120, logs: [] } })
    await vi.waitFor(() => expect(mocks.busy).toBeUndefined())
    expect(mocks.current?.evidence).toHaveLength(1)
    expect(mocks.current?.evidence[0]?.status).toBe('confirmed')
  })

  it.each(['scope', 'unmount', 'unknown'] as const)('stops unsent groups after %s while retaining the first submission', async (change) => {
    mocks.twoProofs = true
    await prepare()
    const reply = deferred<unknown>()
    mocks.runPlan.mockImplementation((_ctx, _backend, _signer, _plan, options) => { options.onSent('first'); return reply.promise })
    mocks.buttons.find((item) => item.className === 'primary')!.onClick()
    if (change === 'scope') mocks.prepareControl!.setScope('changed')
    if (change === 'unmount') leave()
    reply.resolve({ signature: 'first', evidence: { status: change === 'unknown' ? 'unknown' : 'confirmed', signature: 'first', slot: 120, logs: [] } })
    await vi.waitFor(() => expect(mocks.invalidate).toHaveBeenCalled())
    expect(mocks.runPlan).toHaveBeenCalledOnce()
    expect(mocks.current?.evidence).toHaveLength(1)
    expect(mocks.current?.evidence[0]?.signature).toBe('first')
    expect(mocks.prepareControl?.state.plan).toBeUndefined()
  })

  it.each(['en', 'pt'] as const)('blocks renewed preparation after an unknown result but keeps manual verification (%s)', (language) => {
    mocks.language = language
    mocks.current = { ...opened(), evidence: [{ status: 'unknown', signature: 'original', logs: [] }] }
    const html = render()
    expect(html).toContain(messages[language]['incidents.pendingRenewal'])
    expect(html).not.toContain(messages[language]['incidents.prepare'])
    expect(html).toContain(messages[language]['incidents.verify'])
    expect(mocks.runPlan).not.toHaveBeenCalled()
  })

  it('continues separate known groups without invalidating its own pending state update', async () => {
    mocks.twoProofs = true
    await prepare()
    const reply = deferred<unknown>()
    mocks.runPlan.mockImplementationOnce((_ctx, _backend, _signer, _plan, options) => { options.onSent('first'); return reply.promise })
    mocks.buttons.find((item) => item.className === 'primary')!.onClick()
    expect(mocks.current?.state).toBe('awaiting-confirmation')
    render()
    expect(mocks.prepareControl?.state.plan).toHaveLength(2)
    reply.resolve({ signature: 'first', evidence: { status: 'confirmed', signature: 'first', slot: 120, logs: [] } })
    await vi.waitFor(() => expect(mocks.invalidate).toHaveBeenCalled())
    expect(mocks.runPlan).toHaveBeenCalledTimes(2)
    expect(mocks.current?.evidence.map((item) => item.signature)).toEqual(['first', 'signature'])
  })

  it('blocks preparation while awaiting verification even without cached signature evidence', () => {
    mocks.current = { ...opened(), state: 'awaiting-confirmation' }
    expect(render()).not.toContain(messages.en['incidents.prepare'])
    expect(mocks.planRenewBinding).not.toHaveBeenCalled()
  })

  it('keeps an unknown signature blocked after an ineligible manual readback', async () => {
    mocks.current = { ...opened(), evidence: [{ status: 'unknown', signature: 'original', logs: [] }] }
    mocks.inspect.mockImplementation(async ({ mint }: { mint: string }) => ({
      mint, wallet: 'wallet', backend: 'aveo-sas-hook', verdict: 'ineligible', reasons: [{ code: 'AttestationExpired' }],
      read: { cluster: ctx.cluster, rpcUrl: ctx.rpcUrl, commitment: ctx.commitment, slot: 130 },
    }))
    render(); button(messages.en['incidents.verify']).onClick()
    await vi.waitFor(() => expect(mocks.busy).toBeUndefined())
    expect(mocks.current?.state).toBe('open')
    expect(render()).not.toContain(messages.en['incidents.prepare'])
    expect(mocks.current?.evidence[0]?.signature).toBe('original')
    expect(mocks.runPlan).not.toHaveBeenCalled()
  })

  it.each(['en', 'pt'] as const)('shows only a static verification failure and retains evidence (%s)', async (language) => {
    mocks.language = language
    const before = mocks.current
    mocks.inspect.mockRejectedValue(new Error('https://private-rpc/?token=secret'))
    render(); button(messages[language]['incidents.verify']).onClick()
    await vi.waitFor(() => expect(mocks.busy).toBeUndefined())
    const html = render()
    expect(html).toContain(messages[language]['incidents.verifyFailed'])
    expect(html).not.toContain('secret')
    expect(mocks.current).toBe(before)
    expect(mocks.runPlan).not.toHaveBeenCalled()
  })

  it('does not send again after reopening an incident with an immediately recorded signature', async () => {
    await prepare()
    const reply = deferred<unknown>()
    mocks.runPlan.mockImplementation((_ctx, _backend, _signer, _plan, options) => { options.onSent('original'); return reply.promise })
    mocks.buttons.find((item) => item.className === 'primary')!.onClick()
    leave()
    mocks.busy = undefined
    mocks.prepareControl = new PlanPreparation<Review[]>(() => {})
    mocks.verifyControl = new PlanPreparation<unknown[]>(() => {})
    expect(render()).not.toContain(messages.en['incidents.prepare'])
    expect(mocks.runPlan).toHaveBeenCalledOnce()
    reply.resolve({ signature: 'original', evidence: { status: 'unknown', signature: 'original', logs: [] } })
    await vi.waitFor(() => expect(mocks.invalidate).toHaveBeenCalled())
    expect(mocks.runPlan).toHaveBeenCalledOnce()
  })

  it('releases the action lock and clears review even if a store listener throws', async () => {
    await prepare()
    mocks.throwPatch = true
    mocks.buttons.find((item) => item.className === 'primary')!.onClick()
    await vi.waitFor(() => expect(mocks.busy).toBeUndefined())
    expect(mocks.prepareControl?.state.plan).toBeUndefined()
    mocks.throwPatch = false
    render(); button(messages.en['incidents.verify']).onClick()
    await vi.waitFor(() => expect(mocks.inspect).toHaveBeenCalledTimes(2))
  })

  it.each(['scope', 'unmount'] as const)('ignores late eligibility verification after %s', async (change) => {
    const reply = deferred<unknown>()
    mocks.inspect.mockReturnValue(reply.promise)
    render(); button(messages.en['incidents.verify']).onClick()
    if (change === 'scope') mocks.verifyControl!.setScope('changed')
    else leave()
    reply.resolve({ verdict: 'eligible' })
    await vi.waitFor(() => expect(mocks.verifyControl!.state.planning).toBe(false))
    expect(mocks.patch).not.toHaveBeenCalled()
    expect(mocks.current?.state).toBe('open')
  })
})
