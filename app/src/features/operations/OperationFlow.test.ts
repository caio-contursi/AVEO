import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { address } from '@solana/kit'
import { describe, expect, it } from 'vitest'
import type { DeskPlan, DeskEvidence } from '../../api/backend'
import { I18nContext } from '../../i18n/context'
import { messages, type Language } from '../../i18n/messages'
import type { ExecutionState } from './execution'
import { OperationFlow } from './OperationFlow'
import { operationFlow, transferFormLocked, type OperationFlowInput } from './operation-flow'

const publicAddress = address('11111111111111111111111111111111')
const plan: DeskPlan = {
  backend: 'aveo-sas-hook', transaction: '', requiredSigners: [publicAddress], summary: [],
  request: { kind: 'transfer', mint: publicAddress, sourceOwner: publicAddress, destinationOwner: publicAddress, amount: 1n, decimals: 0 },
  simulation: { ok: true, logs: [] },
  diagnostics: {
    source: { backend: 'aveo-sas-hook', mint: publicAddress, wallet: 'source', verdict: 'eligible', reasons: [], sourceAccounts: {}, actions: [], read: { cluster: 'localnet', rpcUrl: 'http://localhost:8899', slot: 1, commitment: 'confirmed', observedAt: '2026-10-09T12:00:00.000Z' } },
    destination: { backend: 'aveo-sas-hook', mint: publicAddress, wallet: 'destination', verdict: 'eligible', reasons: [], sourceAccounts: {}, actions: [], read: { cluster: 'localnet', rpcUrl: 'http://localhost:8899', slot: 1, commitment: 'confirmed', observedAt: '2026-10-09T12:00:00.000Z' } },
  },
}
const base: OperationFlowInput = { planning: false, execution: { phase: 'idle' }, contextMatches: true }
const evidence = (status: DeskEvidence['status']): DeskEvidence => ({ status, signature: 'original', logs: [] })
const input = (patch: Partial<OperationFlowInput> = {}): OperationFlowInput => ({ ...base, ...patch })
const submitted = (status: DeskEvidence['status']): OperationFlowInput => input({
  plan, submissionPlan: plan,
  execution: { phase: 'done', signature: 'original', evidence: evidence(status) },
})

function render(props: OperationFlowInput, language: Language = 'en') {
  return renderToStaticMarkup(createElement(I18nContext.Provider, { value: {
    language, locale: language === 'en' ? 'en-US' : 'pt-BR', setLanguage: () => {},
    t: (key) => messages[language][key],
    has: (key): key is keyof typeof messages.en => key in messages.en,
  } }, createElement(OperationFlow, props)))
}

describe('truthful operation flow', () => {
  it.each([
    { props: input(), stages: ['current', 'pending', 'pending', 'pending'], summary: 'ux.nextPrepare' },
    { props: input({ planning: true, plan }), stages: ['current', 'pending', 'pending', 'pending'], summary: 'ux.nextPreparing' },
    { props: input({ plan }), stages: ['complete', 'current', 'pending', 'pending'], summary: 'ux.nextReview' },
    { props: input({ preparationError: 'preparation-failed' }), stages: ['blocked', 'pending', 'pending', 'pending'], summary: 'ux.nextError' },
    { props: input({ execution: { phase: 'idle', sendBlocked: true } }), stages: ['pending', 'pending', 'pending', 'pending'], summary: 'ux.nextLocked' },
    { props: input({ plan, submissionPlan: plan, execution: { phase: 'signing' } }), stages: ['complete', 'complete', 'current', 'pending'], summary: 'ux.nextWallet' },
    { props: input({ plan, submissionPlan: plan, execution: { phase: 'verifying', signature: 'original' } }), stages: ['complete', 'complete', 'complete', 'current'], summary: 'ux.nextConfirm' },
    { props: submitted('confirmed'), stages: ['complete', 'complete', 'complete', 'complete'], summary: 'ux.nextConfirmed' },
    { props: submitted('failed'), stages: ['complete', 'complete', 'complete', 'blocked'], summary: 'ux.nextFailed' },
    { props: submitted('unknown'), stages: ['complete', 'complete', 'complete', 'unknown'], summary: 'ux.nextUnknown' },
    { props: input({ execution: { phase: 'error', error: { code: 'SimulationFailed', message: 'Rejected' } } }), stages: ['pending', 'pending', 'blocked', 'pending'], summary: 'ux.nextError' },
  ])('maps actual stages to $summary', ({ props, stages, summary }) => {
    expect(operationFlow(props)).toEqual({ stages, summary })
  })

  it.each([true, false])('a blocked plan cannot be ready even with simulation.ok=%s', (ok) => {
    const blocked = { ...plan, simulation: { ok, logs: [] }, blocked: { code: 'SimulationFailed' as const, message: 'Blocked' } }
    expect(operationFlow(input({ plan: blocked }))).toEqual({ stages: ['blocked', 'pending', 'pending', 'pending'], summary: 'ux.nextBlocked' })
  })

  it('failed simulation blocks review and signing', () => {
    const failed = { ...plan, simulation: { ok: false, logs: [] } }
    expect(operationFlow(input({ plan: failed })).stages).toEqual(['blocked', 'pending', 'pending', 'pending'])
  })

  it.each(['verifying', 'done'] as const)('never implies submission or confirmation without a signature (%s)', (phase) => {
    const props = input({ plan, submissionPlan: plan, execution: { phase, evidence: { status: 'confirmed', logs: [] } } })
    expect(operationFlow(props).stages).toEqual(['pending', 'pending', 'pending', 'unknown'])
    expect(render(props)).not.toContain('data-status="complete"')
  })

  it('verifying overrides previously unknown evidence during a read-only recheck', () => {
    const props = submitted('unknown')
    props.execution = { ...props.execution, phase: 'verifying' }
    expect(operationFlow(props).stages[3]).toBe('current')
    expect(operationFlow(props).summary).toBe('ux.nextConfirm')
  })

  it('evidence signature alone identifies the original submission', () => {
    const props = input({ execution: { phase: 'done', evidence: evidence('unknown') } })
    expect(operationFlow(props)).toEqual({ stages: ['unknown', 'unknown', 'complete', 'unknown'], summary: 'ux.nextUnknown' })
  })

  it.each(['confirmed', 'failed', 'unknown'] as const)('context mismatch has no completed current-context stages (%s)', (status) => {
    const props = { ...submitted(status), contextMatches: false }
    expect(operationFlow(props)).toEqual({ stages: ['pending', 'pending', 'pending', 'unknown'], summary: 'ux.nextContext' })
    const html = render(props)
    expect(html).not.toContain('data-status="complete"')
    expect(html).not.toContain('aria-current="step"')
  })

  it('retained results cannot borrow preparation progress from a new form plan', () => {
    for (const currentPlan of [undefined, { ...plan }]) {
      const props = { ...submitted('confirmed'), plan: currentPlan }
      expect(operationFlow(props).stages).toEqual(['unknown', 'unknown', 'complete', 'complete'])
    }
    expect(operationFlow({ ...submitted('confirmed'), submissionPlan: undefined }).stages.slice(0, 2)).toEqual(['unknown', 'unknown'])
  })

  it.each(['en', 'pt'] as const)('shows an ambiguous wallet response as unknown, not refusal (%s)', (language) => {
    const props = input({ plan, submissionPlan: plan, execution: {
      phase: 'error', sendBlocked: true,
      error: { code: 'ConfirmationUnknown', message: 'Submission outcome is unknown' },
    } })
    expect(operationFlow(props)).toEqual({ stages: ['complete', 'complete', 'unknown', 'unknown'], summary: 'ux.nextSubmissionUnknown' })
    expect(transferFormLocked(false, props.execution)).toBe(true)
    const html = render(props, language)
    expect(html).toContain(messages[language]['ux.nextSubmissionUnknown'])
    expect(html).not.toContain(messages[language]['ux.nextError'])
    expect(html).not.toContain('aria-current="step"')
    expect(operationFlow({ ...props, plan: undefined }).stages).toEqual(['unknown', 'unknown', 'unknown', 'unknown'])
  })

  it('wallet rejection preserves review only for the exact plan captured at signing', () => {
    const execution: ExecutionState = { phase: 'error', error: { code: 'SimulationFailed', message: 'Wallet rejected' } }
    const props = input({ plan, submissionPlan: plan, execution })
    expect(operationFlow(props)).toEqual({ stages: ['complete', 'complete', 'blocked', 'pending'], summary: 'ux.nextError' })
    for (const currentPlan of [undefined, { ...plan }]) {
      expect(operationFlow({ ...props, plan: currentPlan }).stages).toEqual(['pending', 'pending', 'blocked', 'pending'])
    }
    expect(operationFlow({ ...props, submissionPlan: undefined }).stages).toEqual(['pending', 'pending', 'blocked', 'pending'])
    expect(render(props)).not.toContain('aria-current="step"')
  })

  it.each([
    input(), input({ planning: true }), input({ plan }),
    input({ plan, submissionPlan: plan, execution: { phase: 'signing' } }),
    input({ plan, submissionPlan: plan, execution: { phase: 'verifying', signature: 'original' } }),
    submitted('confirmed'), submitted('failed'), submitted('unknown'),
    { ...submitted('unknown'), contextMatches: false },
  ])('uses distinct visible marks with translated status text and at most one current step', (props) => {
    const html = render(props)
    const marks = { pending: '○', current: '›', complete: '✓', blocked: '!', unknown: '?' }
    const labels = { pending: 'ux.stagePending', current: 'ux.stageCurrent', complete: 'ux.stageComplete', blocked: 'ux.stageBlocked', unknown: 'ux.stageUnknown' } as const
    const items = html.match(/<li .*?<\/li>/g)!
    operationFlow(props).stages.forEach((status, index) => {
      expect(items[index]).toContain(`<span class="workflow-number" aria-hidden="true">${marks[status]}</span>`)
      expect(items[index]).toContain(messages.en[labels[status]])
    })
    expect((html.match(/aria-current="step"/g) ?? []).length).toBeLessThanOrEqual(1)
  })

  it.each(['en', 'pt'] as const)('shows RPC confirmation separately from unknown party readback (%s)', (language) => {
    const props = submitted('confirmed')
    props.execution.evidence!.readback = [
      { ...plan.diagnostics.source, verdict: 'unknown' },
      { ...plan.diagnostics.destination, verdict: 'ineligible' },
    ]
    const html = render(props, language)
    expect(operationFlow(props).stages[3]).toBe('complete')
    expect(html).toContain(messages[language]['ux.nextConfirmed'])
    expect(html).toContain(messages[language]['ux.flowNote'])
    expect(html).not.toContain(messages[language]['detail.allGood'])
    expect(html).not.toContain(messages[language]['verdict.eligible'])
  })

  it.each(['en', 'pt'] as const)('renders four translated steps and accessible current state (%s)', (language) => {
    const html = render(input({ plan }), language)
    for (const key of ['ux.stepPrepare', 'ux.stepReview', 'ux.stepSign', 'ux.stepVerify', 'ux.stageComplete', 'ux.stageCurrent', 'ux.stagePending'] as const) {
      expect(html).toContain(messages[language][key])
    }
    expect(html.match(/<li /g)).toHaveLength(4)
    expect(html.match(/aria-current="step"/g)).toHaveLength(1)
    expect(html).toContain('role="status" aria-live="polite"')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('progressbar')
  })

  it.each(['en', 'pt'] as const)('unknown is neutral and never styled as a completed verification (%s)', (language) => {
    const html = render(submitted('unknown'), language)
    expect(html).toContain('class="workflow-step unknown" data-status="unknown"')
    expect(html).toContain(messages[language]['ux.stageUnknown'])
    expect(html).toContain(messages[language]['ux.nextUnknown'])
    expect(html).not.toContain('aria-current="step"')
    expect(html.match(/data-status="complete"/g)).toHaveLength(3)
  })
})

describe('intent form lock', () => {
  it.each([
    { phase: 'signing' }, { phase: 'verifying' }, { phase: 'idle', sendBlocked: true },
    { phase: 'done', evidence: evidence('unknown') }, { phase: 'done', signature: 'original' },
  ] satisfies ExecutionState[])('locks inputs for unresolved execution %j', (state) => {
    expect(transferFormLocked(false, state)).toBe(true)
  })

  it('locks preparation but permits read-only planning and resolved results', () => {
    expect(transferFormLocked(true, { phase: 'idle' })).toBe(true)
    expect(transferFormLocked(false, { phase: 'idle' })).toBe(false)
    expect(transferFormLocked(false, { phase: 'error' })).toBe(false)
    expect(transferFormLocked(false, submitted('confirmed').execution)).toBe(false)
    expect(transferFormLocked(false, submitted('failed').execution)).toBe(false)
  })
})
