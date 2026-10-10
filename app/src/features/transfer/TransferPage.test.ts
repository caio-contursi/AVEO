import { createElement, type ReactNode, type FormEvent } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { address } from '@solana/kit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeskPlan } from '../../api/backend'
import type { DeskSnapshot } from '../../api/diagnostics'
import type { ExecutionState } from '../operations/execution'
import { messages, type Language } from '../../i18n/messages'
import { TransferPage } from './TransferPage'

const mocks = vi.hoisted(() => ({
  planTransfer: vi.fn(), prepare: vi.fn(), clear: vi.fn(), isCurrent: vi.fn(),
  execute: vi.fn(), reset: vi.fn(), scope: [] as unknown[],
  recheck: vi.fn(), onRecheck: undefined as (() => void) | undefined,
  preparation: { plan: undefined as DeskPlan | undefined, planning: false, error: undefined as 'preparation-failed' | undefined },
  sign: undefined as (() => void) | undefined,
  submit: undefined as ((event: FormEvent) => void) | undefined,
  language: 'en' as Language,
  execution: { phase: 'idle' } as ExecutionState,
  contextMatches: true,
  holdingsFailed: false, holdingsFetching: false,
  connected: { address: 'source' } as { address: string } | undefined,
}))
const deployment = {
  generatedAt: '2026-10-09T12:00:00.000Z',
  assets: [{ id: 'alfa', label: 'Alfa', symbol: 'ALFA', mint: 'mint', decimals: 0 }],
  wallets: [{ id: 'X', label: 'X', role: 'investor', address: 'source' }, { id: 'Y', label: 'Y', role: 'investor', address: 'destination' }],
}
const ctx = { cluster: 'localnet', rpcUrl: 'http://127.0.0.1:8899', programId: 'program', commitment: 'confirmed', deployment }

vi.mock('../../wallet/context', () => ({ useWallet: () => ({ connected: mocks.connected }) }))
vi.mock('../../app/desk', () => ({
  useReadyDesk: () => ({ ctx, deployment, backend: { planTransfer: mocks.planTransfer } }),
  useDesk: () => ({ explorerUrl: () => null }),
}))
vi.mock('../../i18n/context', () => ({ useI18n: () => ({
  locale: 'en-US', t: (key: keyof typeof messages.en) => messages[mocks.language][key],
  has: (key: string): key is keyof typeof messages.en => key in messages.en,
}) }))
vi.mock('../assets/queries', () => ({ useHoldingsQuery: () => ({ error: mocks.holdingsFailed ? new Error('Offline') : undefined,
  isFetching: mocks.holdingsFetching, data: { holdings: [
  { mint: 'mint', wallet: 'source', amount: 100n }, { mint: 'mint', wallet: 'destination', amount: 50n },
] } }) }))
vi.mock('../operations/useExecutePlan', () => ({ useExecutePlan: () => ({
  state: mocks.execution, contextMatches: mocks.contextMatches,
  displayMetadata: mocks.execution.evidence ? { deployment, decimals: 0 } : undefined,
  reset: mocks.reset, execute: mocks.execute, recheck: mocks.recheck,
}) }))
vi.mock('../operations/usePlanPreparation', () => ({ usePlanPreparation: (scope: unknown[]) => {
  mocks.scope = scope
  return { ...mocks.preparation, prepare: mocks.prepare, clear: mocks.clear, isCurrent: mocks.isCurrent }
} }))
vi.mock('../operations/PlanReview', async (original) => {
  const { PlanReview } = await original<typeof import('../operations/PlanReview')>()
  return { PlanReview: (props: Parameters<typeof PlanReview>[0]) => {
    mocks.sign = props.onSign
    return createElement(PlanReview, props)
  } }
})
vi.mock('../operations/EvidenceView', async (original) => {
  const { EvidenceView } = await original<typeof import('../operations/EvidenceView')>()
  return { EvidenceView: (props: Parameters<typeof EvidenceView>[0]) => {
    mocks.onRecheck = props.onRecheck
    return createElement(EvidenceView, props)
  } }
})
vi.mock('../../components/ui', async (original) => {
  const ui = await original<typeof import('../../components/ui')>()
  return {
    ...ui,
    Card: (props: { children: ReactNode; title?: ReactNode; aside?: ReactNode; className?: string }) => {
      const { children } = props
      for (const child of Array.isArray(children) ? children : [children]) {
        if (child && typeof child === 'object' && 'type' in child && child.type === 'form') {
          mocks.submit = (child as { props: { onSubmit: (event: FormEvent) => void } }).props.onSubmit
        }
      }
      return createElement(ui.Card, props)
    },
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.preparation = { plan: undefined, planning: false, error: undefined }
  mocks.language = 'en'
  mocks.execution = { phase: 'idle' }
  mocks.contextMatches = true
  mocks.holdingsFailed = false
  mocks.holdingsFetching = false
  mocks.connected = { address: 'source' }
  mocks.sign = undefined
  mocks.submit = undefined
  mocks.onRecheck = undefined
  mocks.reset.mockReturnValue(true)
  mocks.isCurrent.mockReturnValue(true)
  mocks.prepare.mockImplementation(async (build: (signal: AbortSignal) => Promise<DeskPlan>) => build(new AbortController().signal))
  mocks.planTransfer.mockResolvedValue({})
})

function render() { return renderToStaticMarkup(createElement(TransferPage)) }

function preparedPlan(ok = true): DeskPlan {
  const snapshot: DeskSnapshot = {
    backend: 'aveo-sas-hook', mint: 'mint', wallet: 'source', verdict: 'eligible', reasons: [], sourceAccounts: {}, actions: [],
    read: { cluster: 'localnet', rpcUrl: ctx.rpcUrl, slot: 1, commitment: 'confirmed', observedAt: deployment.generatedAt },
  }
  const publicAddress = address('11111111111111111111111111111111')
  return {
    backend: 'aveo-sas-hook', transaction: '', requiredSigners: ['source'], summary: [],
    request: { kind: 'transfer', mint: publicAddress, sourceOwner: publicAddress, destinationOwner: publicAddress, amount: 1n, decimals: 0 },
    simulation: { ok, logs: [] }, diagnostics: { source: snapshot, destination: { ...snapshot, wallet: 'destination' } },
  }
}

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
    }, expect.any(AbortSignal))
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

  it.each(['holdingsFailed', 'holdingsFetching'] as const)('does not present cached holdings as a current hint or capture them as pre-send evidence during %s', (state) => {
    mocks.preparation.plan = preparedPlan()
    mocks[state] = true
    const html = render()
    expect(html).not.toContain('class="field-hint"')
    expect(mocks.execute).not.toHaveBeenCalled()
    mocks.sign!()
    expect(mocks.execute).toHaveBeenCalledWith(mocks.preparation.plan, { balancesBefore: undefined })
  })

  it.each([true, false])('requires the plan to remain current before signing (current: %s)', (current) => {
    const plan = preparedPlan()
    mocks.preparation.plan = plan
    mocks.isCurrent.mockReturnValue(current)
    render()
    expect(mocks.execute).not.toHaveBeenCalled()
    mocks.sign!()
    expect(mocks.isCurrent).toHaveBeenCalledWith(plan)
    if (current) expect(mocks.execute).toHaveBeenCalledWith(plan, { balancesBefore: [100n, 50n] })
    else expect(mocks.execute).not.toHaveBeenCalled()
  })

  it.each([
    { phase: 'signing' }, { phase: 'verifying', signature: 'original' },
    { phase: 'idle', sendBlocked: true },
    { phase: 'done', signature: 'original', evidence: { status: 'unknown', signature: 'original', logs: [] } },
  ] satisfies ExecutionState[])('disables every intent control while execution is locked (%j)', (state) => {
    mocks.execution = state
    const html = render()
    expect(html.match(/<select disabled=""/g)).toHaveLength(3)
    expect(html).toMatch(/<input disabled=""/)
    expect(html).toMatch(/<button type="submit" class="primary" disabled=""/)
  })

  it('keeps read-only preparation available without a wallet', async () => {
    mocks.connected = undefined
    expect(render()).not.toMatch(/<button type="submit" class="primary" disabled/)
    mocks.submit!({ preventDefault: () => {} } as FormEvent)
    await vi.waitFor(() => expect(mocks.planTransfer).toHaveBeenCalledOnce())
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it.each([true, false])('blocks signing and expands diagnosis for a blocked plan even when simulation.ok is %s', (ok) => {
    mocks.preparation.plan = { ...preparedPlan(ok), blocked: { code: 'SimulationFailed', message: 'blocked' } }
    const html = render()
    expect(html).toContain(messages.en['ux.nextBlocked'])
    expect(html).toContain('<details open="">')
    mocks.sign!()
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('blocks signing for a failed simulation and leaves successful diagnosis optional', () => {
    mocks.preparation.plan = preparedPlan(false)
    expect(render()).toContain('<details open="">')
    mocks.sign!()
    expect(mocks.execute).not.toHaveBeenCalled()
    mocks.preparation.plan = preparedPlan()
    expect(render()).toContain('<details>')
  })

  it.each(['failed', 'unknown'] as const)('expands diagnosis for %s evidence', (status) => {
    mocks.preparation.plan = preparedPlan()
    mocks.execution = { phase: 'done', signature: 'original', evidence: { status, signature: 'original', logs: [] } }
    expect(render()).toContain('<details open="">')
  })

  it('keeps execution errors visible even after the prepared plan is cleared', () => {
    mocks.execution = { phase: 'error', error: { code: 'SimulationFailed', message: 'Wallet rejected' } }
    const html = render()
    expect(html).toContain('Wallet rejected')
    expect(html).toContain(messages.en['ux.nextError'])
  })

  it('does not show an all-good claim for unknown parties with no diagnostic reasons', () => {
    const plan = preparedPlan()
    mocks.preparation.plan = { ...plan, diagnostics: {
      source: { ...plan.diagnostics.source, verdict: 'unknown' },
      destination: { ...plan.diagnostics.destination, verdict: 'unknown' },
    } }
    expect(render()).not.toContain(messages.en['detail.allGood'])
  })

  it('identifies retained evidence and its original deployment without combining it with a new plan', () => {
    mocks.execution = { phase: 'done', signature: 'original', evidence: { status: 'confirmed', signature: 'original', logs: [] } }
    mocks.contextMatches = false
    const html = render()
    expect(html).toContain(messages.en['ux.retainedEvidence'])
    expect(html).toContain(deployment.generatedAt)
    expect(html).toContain('original')
    expect(html).not.toContain('data-status="complete"')
    mocks.preparation.plan = preparedPlan()
    expect(render()).not.toContain('data-status="complete"')
  })

  it('groups intent and review in one named region with no Card enclosing the decision panel', () => {
    mocks.preparation.plan = preparedPlan()
    const html = render()
    expect(html).toContain(`<section class="stack" aria-label="${messages.en['transfer.title']}"><section class="card `)
    expect(html).toContain(`</section><section aria-label="${messages.en['ux.stepReview']}"><h3>${messages.en['ux.stepReview']}</h3><div class="box decision-panel">`)
    expect(html.indexOf(messages.en['transfer.diagnosis'])).toBeGreaterThan(html.indexOf('decision-panel'))
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('keeps wallet requirements and rejection reasons visible in review', () => {
    mocks.preparation.plan = preparedPlan()
    mocks.connected = { address: 'destination' }
    mocks.execution = { phase: 'error', error: { code: 'SimulationFailed', message: 'Wallet rejected request' } }
    const html = render()
    expect(html).toContain(messages.en['wallet.required'])
    expect(html).toContain(messages.en['wallet.wrong'])
    expect(html).toContain('Wallet rejected request')
    expect(html).toContain('<details open="">')
    expect(html).toMatch(/<button type="button" class="primary" disabled=""/)
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('rechecks unknown evidence without preparing or sending and retains the original signature', () => {
    mocks.execution = { phase: 'done', signature: 'original', evidence: { status: 'unknown', signature: 'original', logs: [] } }
    const html = render()
    expect(html).toContain('original')
    expect(html).toContain(messages.en['evidence.unknown'])
    expect(html).toContain(messages.en['evidence.recheckNote'])
    expect(mocks.recheck).not.toHaveBeenCalled()
    mocks.onRecheck!()
    expect(mocks.recheck).toHaveBeenCalledOnce()
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(mocks.prepare).not.toHaveBeenCalled()
    mocks.execution = { ...mocks.execution, phase: 'verifying' }
    const rechecking = render()
    expect(rechecking).toContain('original')
    expect(rechecking).toContain(messages.en['evidence.unknown'])
    expect(rechecking).toMatch(/<button type="button" disabled=""/)
    expect(rechecking.match(/aria-current="step"/g)).toHaveLength(1)
  })

  it.each(['failed', 'unknown'] as const)('keeps %s evidence and recovery reasons visible without a prepared plan', (status) => {
    mocks.execution = { phase: 'done', signature: 'original', evidence: { status, signature: 'original', logs: [], error: { code: 'ConfirmationUnknown', message: 'Original submission diagnostic' } } }
    const html = render()
    expect(html).toContain('original')
    expect(html).toContain('ConfirmationUnknown')
    expect(html).toContain(messages.en['reason.ConfirmationUnknown'])
    expect(html).toContain(messages.en[`evidence.${status}`])
    expect(mocks.sign).toBeUndefined()
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('keeps retained unknown recovery visible but disables recheck in a different context', () => {
    mocks.contextMatches = false
    mocks.execution = { phase: 'done', signature: 'original', evidence: { status: 'unknown', signature: 'original', logs: [] } }
    const html = render()
    expect(html).toContain('original')
    expect(html).toContain(messages.en['evidence.contextChanged'])
    expect(html).toContain(messages.en['evidence.recheckNote'])
    expect(html).toMatch(/<button type="button" disabled="">/)
    expect(html).not.toContain('aria-current="step"')
    expect(mocks.recheck).not.toHaveBeenCalled()
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(mocks.prepare).not.toHaveBeenCalled()
  })
})
