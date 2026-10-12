import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeskPlan } from '../../api/backend'
import type { ApiContext } from '../../api/context'
import type { DeskSnapshot } from '../../api/diagnostics'
import type { ProofRow } from '../../api/inventory'
import { I18nContext } from '../../i18n/context'
import { messages, type Language } from '../../i18n/messages'
import { BindProofAction } from './BindProofAction'

const mocks = vi.hoisted(() => ({
  ctx: null as ApiContext | null,
  connected: undefined as { address: string } | undefined,
  preparation: {
    plan: undefined as DeskPlan | undefined,
    planning: false,
    error: undefined as 'preparation-failed' | undefined,
    clear: vi.fn(), prepare: vi.fn(), isCurrent: vi.fn(() => true),
  },
  usePlanPreparation: vi.fn(),
  review: vi.fn(),
  planRenewBinding: vi.fn(), reset: vi.fn(() => true), execute: vi.fn(), recheck: vi.fn(),
}))

vi.mock('../../app/desk', () => ({
  useReadyDesk: () => ({ ctx: mocks.ctx, deployment: mocks.ctx!.deployment, backend: { planRenewBinding: mocks.planRenewBinding } }),
}))
vi.mock('../../wallet/context', () => ({ useWallet: () => ({ connected: mocks.connected }) }))
vi.mock('../operations/usePlanPreparation', () => ({ usePlanPreparation: mocks.usePlanPreparation }))
vi.mock('../operations/useExecutePlan', () => ({
  useExecutePlan: () => ({ state: { phase: 'idle' }, reset: mocks.reset, execute: mocks.execute, recheck: mocks.recheck }),
}))
vi.mock('../operations/PlanReview', async (original) => {
  const actual = await original<typeof import('../operations/PlanReview')>()
  return { PlanReview: (props: Parameters<typeof actual.PlanReview>[0]) => {
    mocks.review(props)
    return createElement(actual.PlanReview, props)
  } }
})

const ctx = {
  cluster: 'devnet', rpcUrl: 'https://rpc.invalid', programId: 'program', commitment: 'confirmed',
  deployment: {
    wallets: [{ address: 'subject-wallet', label: 'Investor' }],
    assets: [{ mint: 'asset-mint', label: 'Asset' }],
    verifiers: [{ credential: 'credential', label: 'Verifier' }],
  },
} as ApiContext
const snapshot = {
  mint: 'asset-mint', wallet: 'subject-wallet', read: { slot: 42 },
} as DeskSnapshot
const proof = {
  address: 'proof-address', attestation: { credential: 'credential' },
} as ProofRow
const plan = {
  requiredSigners: [snapshot.wallet], request: { kind: 'set-binding' }, simulation: { ok: true, logs: [] },
} as unknown as DeskPlan

function render(language: Language = 'en', currentSnapshot = snapshot, currentProof = proof) {
  return renderToStaticMarkup(createElement(I18nContext.Provider, { value: {
    language, locale: language === 'en' ? 'en-US' : 'pt-BR', setLanguage: () => {},
    t: (key, params = {}) => messages[language][key].replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match),
    has: (key): key is keyof typeof messages.en => key in messages.en,
  } }, createElement(BindProofAction, { snapshot: currentSnapshot, proof: currentProof })))
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.ctx = ctx
  mocks.connected = { address: snapshot.wallet }
  mocks.preparation.plan = undefined
  mocks.preparation.planning = false
  mocks.preparation.error = undefined
  mocks.preparation.isCurrent.mockReturnValue(true)
  mocks.usePlanPreparation.mockReturnValue(mocks.preparation)
})

describe('BindProofAction preparation markup', () => {
  it('renders the idle action without a plan or alert', () => {
    const html = render()
    expect(html).toMatch(/<button type="button">/)
    expect(html).not.toContain('class="spinner"')
    expect(html).not.toContain('role="alert"')
    expect(html).not.toContain('class="primary"')
  })

  it('disables preparation and displays the spinner while planning', () => {
    mocks.preparation.planning = true
    const html = render()
    expect(html).toMatch(/<button type="button" disabled="">/)
    expect(html).toContain('class="spinner"')
  })

  it.each(['en', 'pt'] as const)('renders a translated static preparation error as an alert (%s)', (language) => {
    mocks.preparation.error = 'preparation-failed'
    const html = render(language)
    expect(html).toContain(`role="alert">${messages[language]['operations.prepareFailed']}</p>`)
    expect(html).not.toContain('preparation-failed')
    expect(html).not.toContain('https://rpc.invalid')
  })

  it.each([undefined, 'other-wallet', 'subject-wallet'])('keeps plans reviewable and guards signing for connected wallet %s', (address) => {
    mocks.connected = address ? { address } : undefined
    mocks.preparation.plan = plan
    const html = render()
    expect(html).toContain(messages.en['plan.simulationOk'])
    expect(html).toMatch(address === snapshot.wallet
      ? /<button type="button" class="primary">/
      : /<button type="button" class="primary" disabled="">/)
    expect(mocks.planRenewBinding).not.toHaveBeenCalled()
    expect(mocks.preparation.prepare).not.toHaveBeenCalled()
    expect(mocks.preparation.clear).not.toHaveBeenCalled()
    expect(mocks.preparation.isCurrent).not.toHaveBeenCalled()
    expect(mocks.reset).not.toHaveBeenCalled()
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(mocks.recheck).not.toHaveBeenCalled()
  })

  it.each([false, true])('checks that the reviewed plan is current before an explicit sign action: %s', (current) => {
    mocks.preparation.plan = plan
    mocks.preparation.isCurrent.mockReturnValue(current)
    render()
    expect(mocks.execute).not.toHaveBeenCalled()
    mocks.review.mock.calls[0]![0].onSign()
    expect(mocks.preparation.isCurrent).toHaveBeenCalledExactlyOnceWith(plan)
    if (current) expect(mocks.execute).toHaveBeenCalledExactlyOnceWith(plan)
    else expect(mocks.execute).not.toHaveBeenCalled()
  })
})

describe('BindProofAction preparation scope', () => {
  it.each([undefined, 'subject-wallet', 'other-wallet'])('declares network, deployment, binding, read slot and connected wallet %s', (address) => {
    mocks.connected = address ? { address } : undefined
    render()
    expect(mocks.usePlanPreparation).toHaveBeenCalledExactlyOnceWith([
      ctx.cluster, ctx.rpcUrl, ctx.programId, ctx.commitment, ctx.deployment,
      snapshot.mint, snapshot.wallet, proof.address, snapshot.read.slot, address,
    ])
  })

  it('passes the current context, proof and snapshot rather than fixed scope values', () => {
    mocks.ctx = { ...ctx, cluster: 'localnet', rpcUrl: 'https://other-rpc.invalid', programId: 'other-program' as ApiContext['programId'], commitment: 'finalized', deployment: { ...ctx.deployment } }
    const nextSnapshot = { ...snapshot, mint: 'other-mint', wallet: 'other-subject', read: { ...snapshot.read, slot: 43 } }
    const nextProof = { ...proof, address: 'other-proof' as ProofRow['address'] }
    render('en', nextSnapshot, nextProof)
    const current = mocks.ctx
    expect(mocks.usePlanPreparation).toHaveBeenCalledExactlyOnceWith([
      current.cluster, current.rpcUrl, current.programId, current.commitment, current.deployment,
      nextSnapshot.mint, nextSnapshot.wallet, nextProof.address, nextSnapshot.read.slot, snapshot.wallet,
    ])
    expect(mocks.usePlanPreparation.mock.calls[0]![0][4]).toBe(current.deployment)
  })
})
