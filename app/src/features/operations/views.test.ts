import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { DeskPlan } from '../../api/backend'
import { I18nContext } from '../../i18n/context'
import { messages, type Language } from '../../i18n/messages'
import { EvidenceView } from './EvidenceView'
import { PlanReview } from './PlanReview'

const { explorerUrl } = vi.hoisted(() => ({ explorerUrl: vi.fn((signature: string) => `https://current-network/tx/${signature}`) }))
vi.mock('../../app/desk', () => ({ useDesk: () => ({ explorerUrl }) }))
vi.mock('../../wallet/context', () => ({ useWallet: () => ({ connected: { address: 'original-wallet' } }) }))
vi.mock('./SimulationSummary', () => ({ SimulationSummary: () => null }))

function render(element: Parameters<typeof renderToStaticMarkup>[0], language: Language = 'en') {
  return renderToStaticMarkup(createElement(I18nContext.Provider, {
    value: {
      language, locale: language === 'en' ? 'en-US' : 'pt-BR', setLanguage: () => {},
      t: (key) => messages[language][key],
      has: (key): key is keyof typeof messages.en => key in messages.en,
    },
  }, element))
}

function evidence(props: Partial<Parameters<typeof EvidenceView>[0]> = {}) {
  return createElement(EvidenceView, {
    evidence: { status: 'unknown', signature: 'original-signature', logs: [] }, labelOf: (a) => a,
    ...props,
  })
}

describe('unknown evidence actions', () => {
  it('warns about failed receipt persistence without changing transaction evidence', () => {
    const html = render(evidence({ persistenceWarning: true }))
    expect(html).toContain(messages.en['receipts.storage-unavailable'])
    expect(html).toContain('role="alert"')
    expect(html).toContain('original-signature')
  })
  it.each(['en', 'pt'] as const)('offers optional recheck and explains the same signature without sending (%s)', (language) => {
    const html = render(evidence({ onRecheck: () => {} }), language)
    expect(html).toContain(messages[language]['evidence.recheck'])
    expect(html).toContain(messages[language]['evidence.recheckNote'])
    expect(html).toMatch(/<button type="button">/)
  })

  it('disables the recheck action and shows busy feedback while checking', () => {
    const html = render(evidence({ onRecheck: () => {}, rechecking: true }))
    expect(html).toMatch(/<button type="button" disabled="">/)
    expect(html).toContain(messages.en['evidence.rechecking'])
    expect(html).toContain('class="spinner"')
  })

  it('suppresses the current-network explorer and disables recheck on mismatch', () => {
    explorerUrl.mockClear()
    const html = render(evidence({ onRecheck: () => {}, contextMatches: false }))
    expect(explorerUrl).not.toHaveBeenCalled()
    expect(html).not.toContain('https://current-network')
    expect(html).toContain('original-signature')
    expect(html).toContain(messages.en['evidence.contextChanged'])
    expect(html).toMatch(/<button type="button" disabled="">/)
  })

  it('keeps old callers compatible and offers no recheck for terminal evidence', () => {
    expect(render(evidence())).not.toContain(messages.en['evidence.recheck'])
    for (const status of ['confirmed', 'failed'] as const) {
      expect(render(evidence({ evidence: { status, signature: 'original-signature', logs: [] }, onRecheck: () => {} }))).not.toContain(messages.en['evidence.recheck'])
    }
  })
})

describe('PlanReview signing guards', () => {
  it.each([
    { phase: 'verifying' as const, signature: 'original-signature' },
    { phase: 'done' as const, signature: 'original-signature' },
    { phase: 'idle' as const, sendBlocked: true },
  ])('keeps signing disabled for %j', (execution) => {
    const plan = { simulation: { ok: true }, requiredSigners: ['original-wallet'] } as DeskPlan
    const html = render(createElement(PlanReview, { plan, signerLabel: 'Wallet', signLabel: 'Sign', execution, onSign: () => {} }))
    expect(html).toMatch(/<button type="button" class="primary" disabled="">/)
  })
})
