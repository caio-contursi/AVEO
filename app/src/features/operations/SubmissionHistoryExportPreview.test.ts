import { getAddressDecoder, getBase58Decoder } from '@solana/kit'
import { createElement, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { I18nContext } from '../../i18n/context'
import { messages, type Language } from '../../i18n/messages'
import { SubmissionHistoryExport } from './SubmissionHistory'
import { exportPublicReceiptHistory, inspectPublicReceiptHistory } from './receipt-export'
import { MAX_RECEIPTS, MAX_RECEIPT_BYTES } from './receipt-limits'
import type { SubmissionReceipt } from './submission-journal'

const signature = (value: number) => getBase58Decoder().decode(new Uint8Array(64).fill(value))
const receipt: SubmissionReceipt = Object.freeze({
  version: 1,
  signature: signature(1),
  submittedAt: '2026-10-09T12:01:00.000Z',
  cluster: 'devnet',
  programId: getAddressDecoder().decode(new Uint8Array(32).fill(7)),
  commitment: 'confirmed',
  deploymentGeneratedAt: '2026-10-09T12:00:00.000Z',
  rpcFingerprint: 'a'.repeat(64),
})

function render(receipts: readonly SubmissionReceipt[], language: Language) {
  return renderToStaticMarkup(createElement(I18nContext.Provider, { value: {
    language, locale: language === 'en' ? 'en-US' : 'pt-BR', setLanguage: () => {},
    t: (key, params = {}) => messages[language][key].replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match),
    has: (key): key is keyof typeof messages.en => key in messages.en,
  } }, createElement(SubmissionHistoryExport, { receipts, getSnapshot: () => receipts })))
}

function escaped(text: string) {
  return renderToStaticMarkup(createElement(Fragment, null, text))
}

function formattedBytes(receipts: readonly SubmissionReceipt[]) {
  return new TextEncoder().encode(JSON.stringify({
    version: 1, kind: 'aveo-public-submission-history', receipts,
  }, null, 2)).length
}

function counter(language: Language, bytes: number) {
  return language === 'en'
    ? `Public backup: ${bytes} / ${MAX_RECEIPT_BYTES} UTF-8 bytes.`
    : `Backup público: ${bytes} / ${MAX_RECEIPT_BYTES} bytes UTF-8.`
}

function previewRegion(html: string) {
  const region = html.match(/<div role="status" aria-live="polite" aria-atomic="true">([\s\S]*?)<\/div>/)
  expect(region).not.toBeNull()
  return region![1]!
}

function expectActions(html: string, language: Language, disabled: boolean) {
  for (const key of ['receipts.copyHistory', 'receipts.exportHistory'] as const) {
    expect(html).toContain(`<button type="button"${disabled ? ' disabled=""' : ''}>${escaped(messages[language][key])}</button>`)
  }
  expect(html.match(/<button\b/g)).toHaveLength(2)
  expect(html).not.toContain('<textarea')
  expect(html).not.toMatch(/\{(?:bytes|maxBytes)\}/)
}

function receiptAtBytes(bytes: number): SubmissionReceipt {
  return {
    ...receipt,
    submittedAt: `2026-10-09T12:01:00.000${'0'.repeat(bytes - formattedBytes([receipt]))}Z`,
  }
}

describe.each(['en', 'pt'] as const)('public history export preview static markup (%s)', (language) => {
  it('measures the formatted public envelope and enables both actions for a nonempty ready snapshot', () => {
    const entries = Object.freeze([receipt])
    const bytes = formattedBytes(entries)
    expect(inspectPublicReceiptHistory(entries)).toEqual({ status: 'ready', bytes, maxBytes: MAX_RECEIPT_BYTES })
    expect(bytes).toBeGreaterThan(new TextEncoder().encode(JSON.stringify(entries)).length)
    const html = render(entries, language)
    const region = previewRegion(html)
    expect(region).toContain(counter(language, bytes))
    expect(region).toContain(escaped(messages[language]['receipts.historyPreviewNote']))
    expect(html).toContain(escaped(messages[language]['receipts.historyExportNote']))
    expect(html).not.toContain(escaped(messages[language]['receipts.historyPreviewTooLarge']))
    expect(html).not.toContain(escaped(messages[language]['receipts.historyPreviewInvalid']))
    expectActions(html, language, false)
  })

  it('explains formatted JSON, compact storage, browser quota, persistence and space limitations', () => {
    const note = messages[language]['receipts.historyPreviewNote']
    const concepts = language === 'en'
      ? [/formatted public JSON/i, /compact storage/i, /browser quota/i, /does not.*persist/i, /export.*does not free.*space/i]
      : [/JSON público formatado/i, /armazenamento compacto/i, /não mede a cota do navegador/i, /nem garante persistência/i, /exportar não libera espaço/i]
    for (const concept of concepts) expect(note).toMatch(concept)
    expect(previewRegion(render([], language))).toContain(escaped(note))
  })

  it('shows the empty public envelope size while disabling both actions', () => {
    const bytes = formattedBytes([])
    expect(bytes).toBeGreaterThan(2)
    expect(inspectPublicReceiptHistory([])).toEqual({ status: 'ready', bytes, maxBytes: MAX_RECEIPT_BYTES })
    const html = render([], language)
    expect(previewRegion(html)).toContain(counter(language, bytes))
    expect(html).not.toContain(escaped(messages[language]['receipts.historyPreviewInvalid']))
    expect(html).not.toContain(escaped(messages[language]['receipts.historyPreviewTooLarge']))
    expectActions(html, language, true)
  })

  it('counts only allowlisted public metadata even when discarded Unicode fields exceed the limit', () => {
    const privateData = 'PRIVATE_RPC_SECRET_🔐'.repeat(MAX_RECEIPT_BYTES)
    const entry = Object.freeze({
      ...receipt, rpcUrl: privateData, seed: privateData, logs: [privateData],
      confirmation: { status: 'confirmed', slot: 999 }, plan: { privateData },
    })
    const entries = Object.freeze([entry])
    const bytes = formattedBytes([receipt])
    expect(inspectPublicReceiptHistory(entries)).toEqual({ status: 'ready', bytes, maxBytes: MAX_RECEIPT_BYTES })
    expect(exportPublicReceiptHistory(entries)).toBe(exportPublicReceiptHistory([receipt]))
    const html = render(entries, language)
    expect(previewRegion(html)).toContain(counter(language, bytes))
    expect(html).not.toMatch(/PRIVATE_RPC_SECRET|🔐|rpcUrl|seed|logs|"confirmation"|"plan"|999/)
    expect(entries[0]).toBe(entry)
    expect(entry.rpcUrl).toBe(privateData)
    expectActions(html, language, false)
  })

  it('keeps both actions enabled at the exact formatted export byte limit', () => {
    const entries = [receiptAtBytes(MAX_RECEIPT_BYTES)]
    expect(formattedBytes(entries)).toBe(MAX_RECEIPT_BYTES)
    expect(inspectPublicReceiptHistory(entries)).toEqual({ status: 'ready', bytes: MAX_RECEIPT_BYTES, maxBytes: MAX_RECEIPT_BYTES })
    expect(exportPublicReceiptHistory(entries)).toBeDefined()
    const html = render(entries, language)
    expect(previewRegion(html)).toContain(counter(language, MAX_RECEIPT_BYTES))
    expect(html).not.toContain(escaped(messages[language]['receipts.historyPreviewTooLarge']))
    expectActions(html, language, false)
  })

  it('warns at one byte over the export limit even when compact storage still fits', () => {
    const entries = [{ ...receiptAtBytes(MAX_RECEIPT_BYTES + 1), rpcUrl: 'PRIVATE_RPC_SECRET' }]
    expect(formattedBytes([receiptAtBytes(MAX_RECEIPT_BYTES + 1)])).toBe(MAX_RECEIPT_BYTES + 1)
    expect(new TextEncoder().encode(JSON.stringify([receiptAtBytes(MAX_RECEIPT_BYTES + 1)])).length).toBeLessThan(MAX_RECEIPT_BYTES)
    expect(inspectPublicReceiptHistory(entries)).toEqual({ status: 'tooLarge', bytes: MAX_RECEIPT_BYTES + 1, maxBytes: MAX_RECEIPT_BYTES })
    expect(exportPublicReceiptHistory(entries)).toBeUndefined()
    const html = render(entries, language)
    const region = previewRegion(html)
    expect(region).toContain(counter(language, MAX_RECEIPT_BYTES + 1))
    const warning = messages[language]['receipts.historyPreviewTooLarge']
    expect(region).toContain(escaped(warning))
    for (const concept of language === 'en'
      ? [/individual.*receipts/i, /no automatic splitting/i, /discard/i]
      : [/recibos individuais/i, /não há divisão/i, /descarte automático/i]) expect(warning).toMatch(concept)
    expect(html).not.toContain(escaped(messages[language]['receipts.historyPreviewInvalid']))
    expect(html).not.toContain('PRIVATE_RPC_SECRET')
    expectActions(html, language, true)
  })

  it('hides counters and disables both actions for malformed, duplicate and excessive snapshots', () => {
    const invalidSnapshots: unknown[][] = [
      [receipt, null],
      [receipt, { ...receipt, signature: 'PRIVATE_RPC_SECRET' }],
      [receipt, { ...receipt, signature: signature(2), submittedAt: '2026-02-30T12:00:00Z' }],
      [receipt, receipt],
      [receipt, { ...receipt, cluster: 'localnet' }],
      Array.from({ length: MAX_RECEIPTS + 1 }, (_, index) => ({ ...receipt, signature: signature(index + 1) })),
    ]
    for (const entries of invalidSnapshots) {
      expect(inspectPublicReceiptHistory(entries)).toEqual({ status: 'invalid', maxBytes: MAX_RECEIPT_BYTES })
      const html = render(entries as SubmissionReceipt[], language)
      const region = previewRegion(html)
      expect(region).toContain(escaped(messages[language]['receipts.historyPreviewInvalid']))
      expect(region).toContain(escaped(messages[language]['receipts.historyPreviewNote']))
      expect(html).not.toContain(language === 'en' ? 'Public backup:' : 'Backup público:')
      expect(html).not.toContain(escaped(messages[language]['receipts.historyPreviewTooLarge']))
      expect(html).not.toContain('PRIVATE_RPC_SECRET')
      expect(html).not.toContain(receipt.signature)
      expectActions(html, language, true)
    }
  })

  it('updates counters and action availability across separate static renders of changed snapshots', () => {
    const first = Object.freeze([receipt])
    const second = Object.freeze([receipt, Object.freeze({ ...receipt, signature: signature(2) })])
    const firstHtml = render(first, language)
    const secondHtml = render(second, language)
    expect(firstHtml).toContain(counter(language, formattedBytes(first)))
    expect(secondHtml).toContain(counter(language, formattedBytes(second)))
    expect(secondHtml).not.toContain(counter(language, formattedBytes(first)))
    expectActions(secondHtml, language, false)
    const emptyHtml = render([], language)
    expect(emptyHtml).toContain(counter(language, formattedBytes([])))
    expect(emptyHtml).not.toContain(counter(language, formattedBytes(second)))
    expectActions(emptyHtml, language, true)
    expect(first).toEqual([receipt])
    expect(second).toHaveLength(2)
  })
})
