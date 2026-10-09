import { address } from '@solana/kit'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { DeskSnapshot } from '../../api/diagnostics'
import { I18nContext } from '../../i18n/context'
import { messages, type Language } from '../../i18n/messages'
import { SnapshotDetail } from './SnapshotDetail'

vi.mock('../../app/desk', () => ({ useReadyDesk: () => ({ deployment: { wallets: [], assets: [], verifiers: [] } }) }))
vi.mock('./queries', () => ({ useAssetsQuery: () => ({ data: { assets: [] } }), useProofsQuery: () => ({ data: [] }) }))

function render(verdict: DeskSnapshot['verdict'], language: Language) {
  const account = address('11111111111111111111111111111111')
  const snapshot: DeskSnapshot = {
    backend: 'aveo-sas-hook', mint: account, wallet: account, verdict,
    read: { cluster: 'localnet', rpcUrl: 'http://localhost:8899', slot: 42, commitment: 'confirmed', observedAt: '2026-10-09T00:00:00Z' },
    sourceAccounts: {}, actions: [], reasons: [],
  }
  return renderToStaticMarkup(createElement(I18nContext.Provider, { value: {
    language, locale: language === 'en' ? 'en-US' : 'pt-BR', setLanguage: () => {},
    t: (key, params = {}) => messages[language][key].replace(/\{(\w+)\}/g,
      (match, name: string) => name in params ? String(params[name]) : match),
    has: (key): key is keyof typeof messages.en => key in messages.en,
  } }, createElement(SnapshotDetail, { snapshot })))
}

describe.each(['en', 'pt'] as const)('inspection reason hierarchy (%s)', (language) => {
  it.each(['unknown', 'ineligible'] as const)('never says all checks passed for %s with no reason entries', (verdict) => {
    const html = render(verdict, language)
    expect(html).not.toContain(messages[language]['detail.allGood'])
    expect(html).not.toContain('class="ok-text"')
    expect(html).toContain(messages[language][`verdict.${verdict}`])
  })

  it('retains the successful reason summary only for eligible snapshots', () => {
    expect(render('eligible', language)).toContain(messages[language]['detail.allGood'])
  })
})
