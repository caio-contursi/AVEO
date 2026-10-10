import { getAddressDecoder, getBase58Decoder } from '@solana/kit'
import { createElement, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nContext } from '../../i18n/context'
import { messages, type Language } from '../../i18n/messages'
import { SubmissionHistoryExport, SubmissionReceiptView } from './SubmissionHistory'
import { exportPublicReceipt, exportPublicReceiptHistory } from './receipt-export'
import type { SubmissionReceipt } from './submission-journal'

// Seed the existing export states to inspect their real fallback markup without a DOM dependency.
const mocks = vi.hoisted(() => ({ states: [] as unknown[] }))
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>()
  return { ...actual, useState: (initial: unknown) => actual.useState(
    initial === undefined && mocks.states.length > 0 ? mocks.states.shift() : initial,
  ) }
})
vi.mock('../../app/desk', () => ({ useDesk: () => ({ explorerUrl: () => null }) }))

const receipt: SubmissionReceipt = {
  version: 1,
  signature: getBase58Decoder().decode(new Uint8Array(64).fill(1)),
  submittedAt: '2026-10-09T12:01:00.000Z', cluster: 'devnet', commitment: 'confirmed',
  programId: getAddressDecoder().decode(new Uint8Array(32).fill(7)),
  deploymentGeneratedAt: '2026-10-09T12:00:00.000Z', rpcFingerprint: 'a'.repeat(64),
}
const receipts = [receipt]

function render(element: Parameters<typeof renderToStaticMarkup>[0], language: Language) {
  return renderToStaticMarkup(createElement(I18nContext.Provider, { value: {
    language, locale: language === 'en' ? 'en-US' : 'pt-BR', setLanguage: () => {},
    t: (key, params = {}) => messages[language][key].replace(/\{(\w+)\}/g,
      (match, name: string) => name in params ? String(params[name]) : match),
    has: (key): key is keyof typeof messages.en => key in messages.en,
  } }, element))
}

function escaped(text: string) {
  return renderToStaticMarkup(createElement(Fragment, null, text))
}

function expectManualCopy(html: string, language: Language, label: string, text: string) {
  const textarea = html.match(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/)
  expect(textarea).not.toBeNull()
  const id = textarea![1]!.match(/\bid="([^"]+)"/)?.[1]
  expect(id).toBeTruthy()
  expect(html).toContain(`<label for="${id}">${escaped(label)}</label>`)
  expect(textarea![1]).toContain('readOnly=""')
  expect(textarea![2]).toBe(escaped(text))
  expect(html).toContain(`<button type="button">${escaped(messages[language]['receipts.selectManualText'])}</button>`)
  expect(html).not.toMatch(/autofocus/i)
  expect(mocks.states).toHaveLength(0)
}

beforeEach(() => { mocks.states = [] })

describe.each(['en', 'pt'] as const)('manual copy controls (%s)', (language) => {
  it.each(['manualExport', 'copyFailed', 'downloadFailed'])('labels history JSON and offers explicit selection for %s', (status) => {
    const text = exportPublicReceiptHistory(receipts)!
    mocks.states = [{ status, text }]
    const html = render(createElement(SubmissionHistoryExport, { receipts, getSnapshot: () => receipts }), language)
    expectManualCopy(html, language, messages[language]['receipts.historyManualText'], text)
  })

  it.each(['manualExport', 'copyFailed'])('labels individual JSON and offers explicit selection for %s', (status) => {
    const text = exportPublicReceipt(receipt)!
    mocks.states = [status, text]
    const html = render(createElement(SubmissionReceiptView, {
      receipt, busy: false, disabled: false, onRecheck: () => {},
    }), language)
    expectManualCopy(html, language, messages[language]['receipts.manualText'], text)
  })
})
