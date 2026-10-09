import { createElement, type ReactNode, type FormEvent } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeskPlan } from '../../api/backend'
import { messages, type Language } from '../../i18n/messages'
import { TransferPage } from './TransferPage'

const mocks = vi.hoisted(() => ({
  planTransfer: vi.fn(), prepare: vi.fn(), clear: vi.fn(), isCurrent: vi.fn(),
  execute: vi.fn(), reset: vi.fn(), scope: [] as unknown[],
  preparation: { plan: undefined as DeskPlan | undefined, planning: false, error: undefined as 'preparation-failed' | undefined },
  sign: undefined as (() => void) | undefined,
  submit: undefined as ((event: FormEvent) => void) | undefined,
  language: 'en' as Language,
}))
const deployment = {
  generatedAt: '2026-10-09T12:00:00.000Z',
  assets: [{ id: 'alfa', label: 'Alfa', symbol: 'ALFA', mint: 'mint', decimals: 0 }],
  wallets: [{ id: 'X', label: 'X', role: 'investor', address: 'source' }, { id: 'Y', label: 'Y', role: 'investor', address: 'destination' }],
}
const ctx = { cluster: 'localnet', rpcUrl: 'http://127.0.0.1:8899', programId: 'program', commitment: 'confirmed', deployment }

vi.mock('../../app/desk', () => ({ useReadyDesk: () => ({ ctx, deployment, backend: { planTransfer: mocks.planTransfer } }) }))
vi.mock('../../wallet/context', () => ({ useWallet: () => ({ connected: { address: 'source' } }) }))
vi.mock('../../i18n/context', () => ({ useI18n: () => ({
  locale: 'en-US', t: (key: keyof typeof messages.en) => messages[mocks.language][key],
}) }))
vi.mock('../assets/queries', () => ({ useHoldingsQuery: () => ({ data: { holdings: [
  { mint: 'mint', wallet: 'source', amount: 100n }, { mint: 'mint', wallet: 'destination', amount: 50n },
] } }) }))
vi.mock('../operations/useExecutePlan', () => ({ useExecutePlan: () => ({
  state: { phase: 'idle' }, reset: mocks.reset, execute: mocks.execute,
}) }))
vi.mock('../operations/usePlanPreparation', () => ({ usePlanPreparation: (scope: unknown[]) => {
  mocks.scope = scope
  return { ...mocks.preparation, prepare: mocks.prepare, clear: mocks.clear, isCurrent: mocks.isCurrent }
} }))
vi.mock('../operations/PlanReview', () => ({ PlanReview: ({ onSign }: { onSign: () => void }) => {
  mocks.sign = onSign
  return createElement('div', null, 'review')
} }))
vi.mock('../../components/ui', async (original) => ({
  ...await original<typeof import('../../components/ui')>(),
  Card: ({ children }: { children: ReactNode }) => {
    for (const child of Array.isArray(children) ? children : [children]) {
      if (child && typeof child === 'object' && 'type' in child && child.type === 'form') {
        mocks.submit = (child as { props: { onSubmit: (event: FormEvent) => void } }).props.onSubmit
      }
    }
    return createElement('section', null, children)
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.preparation = { plan: undefined, planning: false, error: undefined }
  mocks.language = 'en'
  mocks.sign = undefined
  mocks.submit = undefined
  mocks.reset.mockReturnValue(true)
  mocks.isCurrent.mockReturnValue(true)
  mocks.prepare.mockImplementation(async (build: () => Promise<DeskPlan>) => build())
  mocks.planTransfer.mockResolvedValue({})
})

function render() { return renderToStaticMarkup(createElement(TransferPage)) }

describe('transfer preparation integration', () => {
  it('scopes preparation to network, deployment, form and connected wallet without preparing on render', () => {
    render()
    expect(mocks.scope).toEqual([
      ctx.cluster, ctx.rpcUrl, ctx.programId, ctx.commitment, deployment,
      { asset: 'alfa', from: 'source', to: 'destination', amount: '1' }, 'source',
    ])
    expect(() => JSON.stringify(mocks.scope)).not.toThrow()
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('uses the guarded preparation path with captured transfer inputs', async () => {
    render()
    const preventDefault = vi.fn()
    mocks.submit!({ preventDefault } as unknown as FormEvent)
    await vi.waitFor(() => expect(mocks.planTransfer).toHaveBeenCalledTimes(1))
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(mocks.prepare).toHaveBeenCalledOnce()
    expect(mocks.planTransfer).toHaveBeenCalledWith({
      cluster: 'localnet', mint: 'mint', sourceOwner: 'source', destinationOwner: 'destination', amount: 1n,
    })
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('does not prepare while execution reset refuses to discard an unresolved submission', () => {
    mocks.reset.mockReturnValue(false)
    render()
    mocks.submit!({ preventDefault: () => {} } as FormEvent)
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.planTransfer).not.toHaveBeenCalled()
  })

  it.each(['en', 'pt'] as const)('shows a translated static failure without an executable plan (%s)', (language) => {
    mocks.language = language
    mocks.preparation.error = 'preparation-failed'
    const html = render()
    expect(html).toContain(messages[language]['operations.prepareFailed'])
    expect(html).toContain('role="alert"')
    expect(mocks.sign).toBeUndefined()
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('disables preparation while the current simulation is pending', () => {
    mocks.preparation.planning = true
    expect(render()).toMatch(/<button type="submit" class="primary" disabled="">/)
  })

  it.each([true, false])('requires the plan to remain current before signing (current: %s)', (current) => {
    const snapshot = { wallet: 'source', verdict: 'eligible', reasons: [] }
    const plan = { diagnostics: { source: snapshot, destination: { ...snapshot, wallet: 'destination' } } } as unknown as DeskPlan
    mocks.preparation.plan = plan
    mocks.isCurrent.mockReturnValue(current)
    render()
    expect(mocks.execute).not.toHaveBeenCalled()
    mocks.sign!()
    expect(mocks.isCurrent).toHaveBeenCalledWith(plan)
    if (current) expect(mocks.execute).toHaveBeenCalledWith(plan, { balancesBefore: [100n, 50n] })
    else expect(mocks.execute).not.toHaveBeenCalled()
  })
})
