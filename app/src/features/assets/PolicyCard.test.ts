import type { Address } from '@solana/kit'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeskPlan } from '../../api/backend'
import type { AssetState } from '../../api/inventory'
import { PolicyCard } from './PolicyCard'

const mocks = vi.hoisted(() => ({
  inputs: [] as { onChange: (event: { target: { checked: boolean } }) => void }[],
  buttons: [] as { onClick: () => void }[],
  setForm: vi.fn(), reset: vi.fn(() => true), clear: vi.fn(),
  prepare: vi.fn(), planUpdatePolicy: vi.fn(), execute: vi.fn(),
  scope: vi.fn(), isCurrent: vi.fn(() => true),
  review: null as { onSign: () => void; plan: DeskPlan } | null,
  preparation: { planning: false, error: undefined as 'preparation-failed' | undefined, plan: undefined as DeskPlan | undefined },
}))

// Open the private editor for SSR without exporting a component solely for tests.
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>()
  return { ...actual, useState: (initial: unknown) => {
    if (initial === false) return [true, vi.fn()]
    if (initial && typeof initial === 'object' && 'credentials' in initial) return [initial, mocks.setForm]
    return [initial, vi.fn()]
  } }
})

// Retain event handlers from the same tree that is rendered to static markup.
vi.mock('react/jsx-dev-runtime', async (original) => {
  const actual = await original<typeof import('react/jsx-dev-runtime')>()
  function capture(...args: Parameters<typeof actual.jsxDEV>) {
    const [type, props] = args
    if (type === 'input') mocks.inputs.push(props as typeof mocks.inputs[number])
    if (type === 'button') mocks.buttons.push(props as typeof mocks.buttons[number])
    return actual.jsxDEV(...args)
  }
  return { ...actual, jsxDEV: capture }
})

const deployment = {
  verifiers: [{ credential: 'credential', schema: 'schema', label: 'Verifier' }],
  wallets: [], assets: [], issuer: 'issuer',
}
const ctx = { cluster: 'devnet', rpcUrl: 'https://private.invalid', programId: 'program', commitment: 'confirmed', deployment }
vi.mock('../../app/desk', () => ({ useReadyDesk: () => ({
  ctx, deployment, backend: { planUpdatePolicy: mocks.planUpdatePolicy },
}) }))
vi.mock('../../wallet/context', () => ({ useWallet: () => ({ connected: { address: 'issuer' } }) }))
vi.mock('../../i18n/context', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('../../components/Address', () => ({ Address: () => null }))
vi.mock('../operations/EvidenceView', () => ({ EvidenceView: () => null }))
vi.mock('../operations/PlanReview', () => ({ PlanReview: (props: typeof mocks.review) => {
  mocks.review = props
  return createElement('div', null, 'Review prepared policy')
} }))
vi.mock('../operations/useExecutePlan', () => ({ useExecutePlan: () => ({
  state: { phase: 'idle' }, reset: mocks.reset, execute: mocks.execute,
}) }))
vi.mock('../operations/usePlanPreparation', () => ({ usePlanPreparation: (scope: readonly unknown[]) => {
  mocks.scope(scope)
  return { ...mocks.preparation, prepare: mocks.prepare, clear: mocks.clear, isCurrent: mocks.isCurrent }
} }))

function asset(): AssetState {
  return {
    asset: { id: 'asset', mint: 'mint' as Address, label: 'Asset', symbol: 'AST', decimals: 6 }, policyAddress: 'policy' as Address,
    policy: {
      version: 1, mint: 'mint' as Address, sasProgramId: 'sas' as Address, pairCount: 1, bump: 255,
      issuerAuthority: 'issuer' as Address, policyVersion: 7n, proofDomain: new Uint8Array(32).fill(1),
      pairs: [{ credential: 'credential' as Address, schema: 'schema' as Address }],
      requireKyc: true, requireAccredited: false, active: true,
    },
    extraMetasExists: true, mintExists: true,
  }
}

function render(state = asset()) {
  return renderToStaticMarkup(createElement(PolicyCard, { state }))
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.inputs = []
  mocks.buttons = []
  mocks.review = null
  mocks.preparation = { planning: false, error: undefined, plan: undefined }
  mocks.reset.mockReturnValue(true)
  mocks.isCurrent.mockReturnValue(true)
  mocks.prepare.mockImplementation(async (build: (signal: AbortSignal) => Promise<DeskPlan>) => {
    try { return await build(new AbortController().signal) } catch { return undefined }
  })
  mocks.planUpdatePolicy.mockResolvedValue({ id: 'prepared-policy' })
})

describe('policy preparation integration', () => {
  it('scopes preparation to network, deployment, mint, policy version, form and wallet', () => {
    render()
    expect(mocks.scope).toHaveBeenCalledExactlyOnceWith([
      ctx.cluster, ctx.rpcUrl, ctx.programId, ctx.commitment, deployment, 'mint', '7',
      { credentials: ['credential'], requireKyc: true, requireAccredited: false, active: true }, 'issuer',
    ])
    expect(() => JSON.stringify(mocks.scope.mock.calls[0][0])).not.toThrow()
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it.each([0, 1, 2, 3])('blocks editing control %i while an operation is unresolved', (index) => {
    render()
    mocks.reset.mockReturnValue(false)
    mocks.inputs[index].onChange({ target: { checked: false } })
    expect(mocks.reset).toHaveBeenCalledOnce()
    expect(mocks.clear).not.toHaveBeenCalled()
    expect(mocks.setForm).not.toHaveBeenCalled()
  })

  it.each([0, 1, 2, 3])('clears preparation before updating control %i', (index) => {
    render()
    const event = { target: { checked: index === 2 } }
    mocks.inputs[index].onChange(event)
    event.target.checked = !event.target.checked
    expect(mocks.reset.mock.invocationCallOrder[0]).toBeLessThan(mocks.clear.mock.invocationCallOrder[0])
    expect(mocks.clear.mock.invocationCallOrder[0]).toBeLessThan(mocks.setForm.mock.invocationCallOrder[0])
    const current = { credentials: ['credential'], requireKyc: true, requireAccredited: false, active: true }
    const next = mocks.setForm.mock.calls[0][0](current)
    expect(next).toEqual({ ...current, ...[
      { credentials: [] }, { requireKyc: false }, { requireAccredited: true }, { active: false },
    ][index] })
  })

  it('does not prepare when reset refuses a new operation', () => {
    render()
    mocks.reset.mockReturnValue(false)
    mocks.buttons[0].onClick()
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.planUpdatePolicy).not.toHaveBeenCalled()
  })

  it('captures policy arguments and only prepares, without automatically sending', async () => {
    const state = asset()
    render(state)
    mocks.buttons[0].onClick()
    state.asset.mint = 'changed-mint' as typeof state.asset.mint
    const policy = state.policy!
    const sourceDomain = policy.proofDomain as Uint8Array
    sourceDomain.fill(2)
    policy.pairs[0].schema = 'changed-schema' as typeof policy.pairs[number]['schema']
    await mocks.prepare.mock.results[0].value
    expect(mocks.planUpdatePolicy).toHaveBeenCalledExactlyOnceWith({
      mint: 'mint', authority: 'issuer', args: {
        proofDomain: new Uint8Array(32).fill(1), pairs: [{ credential: 'credential', schema: 'schema' }],
        requireKyc: true, requireAccredited: false, active: true,
      },
    }, expect.any(AbortSignal))
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('routes backend rejection through preparation without an unhandled promise', async () => {
    mocks.planUpdatePolicy.mockRejectedValue(new Error('private RPC details'))
    render()
    mocks.buttons[0].onClick()
    await expect(mocks.prepare.mock.results[0].value).resolves.toBeUndefined()
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('shows only the static preparation alert and busy feedback', () => {
    mocks.preparation.error = 'preparation-failed'
    mocks.preparation.planning = true
    const html = render()
    expect(html).toContain('role="alert">operations.prepareFailed</p>')
    expect(html).toContain('<button type="button" disabled="">')
    expect(html).toContain('class="spinner"')
    expect(html).not.toContain(ctx.rpcUrl)
    expect(html).not.toContain('preparation-failed')
  })

  it('signs only the current prepared plan after an explicit action', () => {
    const plan = { id: 'prepared-policy' } as unknown as DeskPlan
    mocks.preparation.plan = plan
    expect(render()).toContain('Review prepared policy')
    expect(mocks.execute).not.toHaveBeenCalled()
    mocks.isCurrent.mockReturnValue(false)
    mocks.review!.onSign()
    expect(mocks.execute).not.toHaveBeenCalled()
    mocks.isCurrent.mockReturnValue(true)
    mocks.review!.onSign()
    expect(mocks.isCurrent).toHaveBeenCalledWith(plan)
    expect(mocks.execute).toHaveBeenCalledExactlyOnceWith(plan)
  })
})
