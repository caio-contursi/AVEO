import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { address } from '@solana/kit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeskEvidence, DeskPlan } from '../../api/backend'
import { I18nContext } from '../../i18n/context'
import { messages, type Language } from '../../i18n/messages'
import { EvidenceView } from './EvidenceView'
import { PlanReview } from './PlanReview'
import { SimulationSummary } from './SimulationSummary'
import type { ExecutionState } from './useExecutePlan'

const { wallet, explorerUrl } = vi.hoisted(() => ({
  wallet: { connected: { address: 'required-wallet' } as { address: string } | null },
  explorerUrl: vi.fn((signature: string) => `https://current-network/tx/${signature}`),
}))
vi.mock('../../wallet/context', () => ({ useWallet: () => wallet }))
vi.mock('../../app/desk', () => ({ useDesk: () => ({ explorerUrl }) }))

function render(element: Parameters<typeof renderToStaticMarkup>[0], language: Language) {
  return renderToStaticMarkup(createElement(I18nContext.Provider, {
    value: {
      language, locale: language === 'en' ? 'en-US' : 'pt-BR', setLanguage: () => {},
      t: (key, params) => Object.entries(params ?? {}).reduce(
        (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), messages[language][key],
      ),
      has: (key): key is keyof typeof messages.en => key in messages.en,
    },
  }, element))
}

function plan(overrides: Partial<DeskPlan> = {}): DeskPlan {
  return {
    backend: 'aveo-sas-hook', transaction: '', summary: [], requiredSigners: ['required-wallet'],
    request: { kind: 'transfer' }, diagnostics: {}, simulation: { ok: true, logs: [] },
    ...overrides,
  } as DeskPlan
}

function review(language: Language, overrides: Partial<DeskPlan> = {}, execution: ExecutionState = { phase: 'idle' }) {
  return render(createElement(PlanReview, {
    plan: plan(overrides), signerLabel: 'Required wallet', signLabel: 'Sign', execution, onSign: vi.fn(),
  }), language)
}

function evidence(language: Language, value: DeskEvidence, props: Partial<Parameters<typeof EvidenceView>[0]> = {}) {
  return render(createElement(EvidenceView, { evidence: value, labelOf: (value) => value, ...props }), language)
}

beforeEach(() => {
  wallet.connected = { address: 'required-wallet' }
  explorerUrl.mockClear()
})

describe.each(['en', 'pt'] as const)('decision UX (%s)', (language) => {
  it('shows accepted preflight before the enabled signing action', () => {
    const html = review(language)
    expect(html).toContain(messages[language]['transfer.simulationOk'])
    expect(html).toContain('<button type="button" class="primary">')
    expect(html.indexOf(messages[language]['transfer.simulationOk'])).toBeLessThan(html.indexOf('class="primary"'))
    expect(html).toContain('role="status"')
    expect(html).not.toContain(messages[language]['evidence.confirmed'])
  })

  it('keeps failed preflight and reasons outside collapsed technical details', () => {
    const html = review(language, { simulation: {
      ok: false, logs: ['preflight log'], unitsConsumed: 0,
      error: { code: 'SimulationFailed', message: 'preflight rejection detail' },
    } })
    expect(html).toContain(messages[language]['transfer.simulationFail'])
    expect(html).toContain('<button type="button" class="primary" disabled="">')
    expect(html.indexOf('preflight rejection detail')).toBeLessThan(html.indexOf('<details'))
    expect(html).toContain(`<details class="technical-details"><summary>${messages[language]['ux.technicalDetails']}</summary>`)
    expect(html).toContain(messages[language]['transfer.logs'])
    expect(html).toContain('preflight log')
    expect(html).toContain(messages[language]['transfer.cu'].replace('{units}', '0'))
    expect(html).not.toContain('<details open')
  })

  it('blocks signing and uses failure styling even when a blocked plan reports successful simulation', () => {
    const html = review(language, { blocked: { code: 'MissingExtraAccounts', message: 'blocked account detail' } })
    expect(html).toContain('<button type="button" class="primary" disabled="">')
    expect(html).toContain('class="simulation bad"')
    expect(html).toContain(messages[language]['transfer.blocked'])
    expect(html).toContain('blocked account detail')
  })

  it('keeps required wallet guidance visible when disconnected or connected to the wrong wallet', () => {
    wallet.connected = null
    const disconnected = review(language)
    expect(disconnected).toContain('<button type="button" class="primary" disabled="">')
    expect(disconnected).toContain(messages[language]['wallet.required'].replace('{wallet}', 'Required wallet'))
    wallet.connected = { address: 'wrong-wallet' }
    expect(review(language)).toContain(messages[language]['wallet.wrong'].replace('{wallet}', 'Required wallet'))
    expect(review(language)).toContain('<button type="button" class="primary" disabled="">')
  })

  it('keeps distinct blocking and simulation reasons visible before technical details', () => {
    const html = review(language, {
      blocked: { code: 'MissingExtraAccounts', message: 'missing account blocker' },
      simulation: { ok: false, logs: ['technical log'], error: { code: 'SimulationFailed', message: 'separate simulation failure' } },
    })
    expect(html.indexOf('missing account blocker')).toBeGreaterThan(-1)
    expect(html.indexOf('missing account blocker')).toBeLessThan(html.indexOf('<details'))
    expect(html.indexOf('separate simulation failure')).toBeGreaterThan(-1)
    expect(html.indexOf('separate simulation failure')).toBeLessThan(html.indexOf('<details'))
  })

  it('does not repeat the shared backend blocking reason', () => {
    const reason = { code: 'MissingExtraAccounts' as const, message: 'shared backend blocker' }
    const html = review(language, { blocked: reason, simulation: { ok: false, logs: [], error: reason } })
    expect(html.match(/shared backend blocker/g)).toHaveLength(1)
  })

  it.each<ExecutionState>([
    { phase: 'signing' }, { phase: 'verifying' }, { phase: 'done' },
    { phase: 'idle', signature: 'retained-signature' }, { phase: 'error', sendBlocked: true },
  ])('preserves the signing guard for %j', (execution) => {
    expect(review(language, {}, execution)).toContain('<button type="button" class="primary" disabled="">')
  })

  it('keeps execution errors visible', () => {
    expect(review(language, {}, { phase: 'error', error: {
      code: 'SimulationFailed', message: 'wallet execution error',
    } })).toContain('wallet execution error')
  })

  it.each(['unknown', 'failed'] as const)('keeps %s evidence and its reason prominent', (status) => {
    const html = evidence(language, {
      status, signature: 'retained-signature', logs: ['transaction log'],
      error: { code: 'ReadUnverifiable', message: 'verification error detail' },
    }, { onRecheck: vi.fn() })
    expect(html).toContain(messages[language][`evidence.${status}`])
    expect(html).toContain('role="status"')
    expect(html.indexOf('verification error detail')).toBeLessThan(html.indexOf('<details'))
    if (status === 'unknown') {
      expect(html).toContain(messages[language]['evidence.recheck'])
      expect(html).toContain(messages[language]['evidence.recheckNote'])
    }
  })

  it.each(['confirmed', 'failed', 'unknown'] as const)('retains historical %s evidence while marking a context mismatch unknown', (status) => {
    const value: DeskEvidence = { status, signature: 'retained-signature', slot: 123, logs: [] }
    const html = evidence(language, value, { contextMatches: false, onRecheck: vi.fn() })
    expect(html).toContain(`<span class="badge unknown">${messages[language]['evidence.unknown']}</span>`)
    expect(html).not.toContain('class="badge ok"')
    expect(html).toContain(`${messages[language]['ux.retainedEvidence']}: ${messages[language][`evidence.${status}`]}`)
    expect(html).toContain('role="alert"')
    expect(html).toContain(messages[language]['evidence.contextChanged'])
    expect(html).toContain('retained-signature')
    expect(html).toContain(messages[language]['evidence.slot'].replace('{slot}', '123'))
    expect(explorerUrl).not.toHaveBeenCalled()
    expect(value.status).toBe(status)
    if (status === 'unknown') expect(html).toContain('<button type="button" disabled="">')
  })

  it('distinguishes confirmed transactions from ineligible readback and preserves logs', () => {
    const account = address('11111111111111111111111111111111')
    const html = evidence(language, {
      status: 'confirmed', signature: 'retained-signature', slot: 123, logs: ['transaction log'],
      balances: [{ owner: account, before: 1n, after: 2n }],
      readback: [{
        backend: 'aveo-sas-hook', mint: account, wallet: account, verdict: 'ineligible',
        read: { cluster: 'devnet', rpcUrl: 'https://original-network', slot: 123, commitment: 'confirmed', observedAt: '2026-10-09T00:00:00Z' },
        sourceAccounts: {}, actions: [], reasons: [{ code: 'ReadUnverifiable', message: 'unverifiable' }],
      }],
    })
    expect(html).toContain(messages[language]['ux.confirmationNote'])
    expect(html).toContain(`<span class="badge ok">${messages[language]['evidence.confirmed']}</span>`)
    expect(html).toContain(messages[language]['verdict.ineligible'])
    expect(html).toContain(messages[language]['evidence.balances'])
    expect(html).toContain('<td>1</td><td>2</td>')
    expect(html.indexOf('ReadUnverifiable')).toBeLessThan(html.indexOf('<details'))
    expect(html).toContain(`<summary>${messages[language]['evidence.logs']}</summary>`)
    expect(html).toContain('transaction log')
    expect(html).not.toContain('<details open')
  })

  it('never displays retained eligible readback as current green evidence after a context change', () => {
    const account = address('11111111111111111111111111111111')
    const value: DeskEvidence = {
      status: 'confirmed', signature: 'retained-signature', logs: [],
      readback: [{ backend: 'aveo-sas-hook', mint: account, wallet: account, verdict: 'eligible',
        read: { cluster: 'devnet', rpcUrl: 'https://original-network', slot: 123, commitment: 'confirmed', observedAt: '2026-10-09T00:00:00Z' },
        sourceAccounts: {}, actions: [], reasons: [],
      }],
    }
    const html = evidence(language, value, { contextMatches: false })
    expect(html).not.toContain('class="badge ok"')
    expect(html).toContain(messages[language]['ux.retainedReadback'].replace('{verdict}', messages[language]['verdict.eligible']))
    expect(value.readback![0]!.verdict).toBe('eligible')
  })

  it('keeps program preflight language for non-transfer operations and exposes compute-only details', () => {
    const value = plan({ request: { kind: 'set-binding' } as DeskPlan['request'], simulation: { ok: true, logs: [], unitsConsumed: 10 } })
    const html = render(createElement(SimulationSummary, { plan: value }), language)
    expect(html).toContain(messages[language]['plan.simulationOk'])
    expect(html).toContain(messages[language]['ux.technicalDetails'])
    expect(html).not.toContain(messages[language]['transfer.logs'])
  })
})
