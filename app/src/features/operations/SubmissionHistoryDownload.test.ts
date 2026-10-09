import { getAddressDecoder, getBase58Decoder } from '@solana/kit'
import { createElement, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nContext } from '../../i18n/context'
import { messages, type Language } from '../../i18n/messages'
import { createHistoryExport, SubmissionHistoryExport } from './SubmissionHistory'
import { downloadPublicReceiptHistory } from './receipt-download'
import { exportPublicReceiptHistory, inspectPublicReceiptHistory } from './receipt-export'
import { MAX_RECEIPTS, MAX_RECEIPT_BYTES } from './receipt-limits'
import type { SubmissionReceipt } from './submission-journal'

// Keep serialization and clipboard behavior real; control only the download boundary.
vi.mock('./receipt-download', async (original) => {
  const actual = await original<typeof import('./receipt-download')>()
  return { ...actual, downloadPublicReceiptHistory: vi.fn(actual.downloadPublicReceiptHistory) }
})

const download = vi.mocked(downloadPublicReceiptHistory)
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
const entries = Object.freeze([receipt])

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

function oversized(): SubmissionReceipt[] {
  const bytes = new TextEncoder().encode(exportPublicReceiptHistory(entries)!).length
  return [{ ...receipt, submittedAt: `2026-10-09T12:01:00.000${'0'.repeat(MAX_RECEIPT_BYTES + 1 - bytes)}Z` }]
}

function deferredClipboard() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const writeText = vi.fn((_text: string) => new Promise<void>((done, fail) => { resolve = done; reject = fail }))
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  return { writeText, resolve: () => resolve(), reject: () => reject(new Error('PRIVATE_CLIPBOARD_SECRET')) }
}

beforeEach(async () => {
  const actual = await vi.importActual<typeof import('./receipt-download')>('./receipt-download')
  download.mockReset().mockImplementation(actual.downloadPublicReceiptHistory)
  vi.stubGlobal('document', undefined)
})

afterEach(() => { vi.unstubAllGlobals() })

describe.each(['en', 'pt'] as const)('visible public history download static markup (%s)', (language) => {
  it('offers a third enabled action without initiating browser or network work during SSR', () => {
    const writeText = vi.fn(), fetch = vi.fn(), setItem = vi.fn()
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('localStorage', { setItem })
    const html = render(entries, language)
    expect(html.match(/<button\b/g)).toHaveLength(3)
    for (const key of ['receipts.copyHistory', 'receipts.exportHistory', 'receipts.downloadHistory'] as const) {
      expect(html).toContain(`<button type="button">${escaped(messages[language][key])}</button>`)
    }
    expect(html).toContain(escaped(messages[language]['receipts.downloadNote']))
    expect(html).not.toContain('<textarea')
    expect(html).not.toContain('aveo-public-submission-history.json')
    expect(html).not.toContain(escaped(messages[language]['receipts.downloadRequested']))
    expect(download).not.toHaveBeenCalled()
    expect(writeText).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
  })

  it('disables download alongside manual export for empty, invalid, duplicate and oversized snapshots', () => {
    const snapshots: readonly SubmissionReceipt[][] = [
      [], [{ ...receipt, signature: 'PRIVATE_SIGNATURE_SECRET' }], [receipt, receipt],
      Array.from({ length: MAX_RECEIPTS + 1 }, (_, index) => ({ ...receipt, signature: signature(index + 1) })),
      oversized(),
    ]
    expect(inspectPublicReceiptHistory(snapshots[4])).toMatchObject({ status: 'tooLarge', bytes: MAX_RECEIPT_BYTES + 1 })
    for (const snapshot of snapshots) {
      const html = render(snapshot, language)
      expect(html.match(/<button\b/g)).toHaveLength(3)
      for (const key of ['receipts.copyHistory', 'receipts.exportHistory', 'receipts.downloadHistory'] as const) {
        expect(html).toContain(`<button type="button" disabled="">${escaped(messages[language][key])}</button>`)
      }
      expect(html).toContain(escaped(messages[language]['receipts.downloadNote']))
      expect(html).not.toContain('<textarea')
      expect(html).not.toContain('PRIVATE_SIGNATURE_SECRET')
    }
    expect(download).not.toHaveBeenCalled()
  })

  it('explains that a download request proves neither saving, persistence nor confirmation', () => {
    const note = messages[language]['receipts.downloadNote']
    const concepts = language === 'en'
      ? [/validated public backup/i, /does not prove.*saved/i, /receipts persisted/i, /transactions confirmed/i, /no data is imported/i, /no space is freed/i]
      : [/backup público validado/i, /não comprova.*salvo/i, /recibos persistiram/i, /transações foram confirmadas/i, /não importa dados/i, /nem libera espaço/i]
    for (const concept of concepts) expect(note).toMatch(concept)
    expect(render(entries, language)).toContain(escaped(note))
    expect(messages[language]['receipts.downloadRequested']).toMatch(language === 'en' ? /requested.*Check.*browser saved/i : /solicitado.*Confira.*navegador salvou/i)
    expect(messages[language]['receipts.downloadFailed']).toMatch(language === 'en' ? /unavailable.*browser.*Select.*JSON.*manually/i : /indisponível.*navegador.*Selecione.*JSON.*manualmente/i)
  })
})

describe('controlled visible history download lifecycle', () => {
  it('publishes a synchronous request with no JSON text, clipboard, storage or network access', () => {
    const changed = vi.fn(), writeText = vi.fn(), fetch = vi.fn(), setItem = vi.fn()
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('localStorage', { setItem })
    download.mockReturnValue({ status: 'downloadRequested' })
    const exporter = createHistoryExport(changed)
    expect(download).not.toHaveBeenCalled()
    expect(changed).not.toHaveBeenCalled()
    expect(exporter.download(entries, () => true)).toBeUndefined()
    expect(download).toHaveBeenCalledTimes(1)
    expect(download).toHaveBeenCalledWith(entries, expect.any(Function))
    expect(download.mock.calls[0]![1]!()).toBe(true)
    expect(changed.mock.calls).toEqual([[{ status: 'downloadRequested' }]])
    expect(writeText).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
  })

  it('offers only allowlisted manual JSON when the browser download API fails', () => {
    const changed = vi.fn(), writeText = vi.fn()
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    vi.stubGlobal('document', { createElement: () => { throw new Error('PRIVATE_BROWSER_SECRET') } })
    const privateEntry = Object.freeze({ ...receipt, rpcUrl: 'PRIVATE_RPC_SECRET', seed: 'PRIVATE_SEED_SECRET',
      logs: ['PRIVATE_LOG_SECRET'], confirmation: { status: 'confirmed', slot: 999 }, plan: 'PRIVATE_PLAN_SECRET' })
    createHistoryExport(changed).download([privateEntry], () => true)
    expect(changed).toHaveBeenCalledTimes(1)
    const state = changed.mock.calls[0]![0]
    expect(state.status).toBe('downloadFailed')
    expect(state.text).toBe(exportPublicReceiptHistory(entries))
    expect(JSON.parse(state.text)).toEqual({ version: 1, kind: 'aveo-public-submission-history', receipts: [receipt] })
    expect(JSON.stringify(changed.mock.calls)).not.toMatch(/PRIVATE_|rpcUrl|seed|logs|confirmation|plan|999/)
    expect(writeText).not.toHaveBeenCalled()
    expect(privateEntry.rpcUrl).toBe('PRIVATE_RPC_SECRET')
  })

  it('falls back to manual JSON when no document is available', () => {
    const changed = vi.fn()
    createHistoryExport(changed).download(entries, () => true)
    expect(changed.mock.calls).toEqual([[{ status: 'downloadFailed', text: exportPublicReceiptHistory(entries) }]])
  })

  it('rejects complete invalid or oversized snapshots without returning secrets or partial JSON', () => {
    for (const snapshot of [[receipt, receipt], [receipt, { ...receipt, signature: 'PRIVATE_SECRET' }], oversized()]) {
      const changed = vi.fn()
      createHistoryExport(changed).download(snapshot, () => true)
      expect(changed.mock.calls).toEqual([[{ status: 'invalidExport' }]])
      expect(JSON.stringify(changed.mock.calls)).not.toContain('PRIVATE_SECRET')
    }
  })

  it('ignores empty, inactive, stale and throwing-current requests before invoking the helper', () => {
    const changed = vi.fn(), exporter = createHistoryExport(changed)
    exporter.download([], () => true)
    exporter.download(entries, () => false)
    const newer = Object.freeze([{ ...receipt, signature: signature(2) }])
    const visible: readonly SubmissionReceipt[] = newer
    exporter.download(entries, () => visible === entries)
    expect(() => exporter.download(entries, () => { throw new Error('PRIVATE_CURRENT_SECRET') })).not.toThrow()
    expect(download).not.toHaveBeenCalled()
    expect(changed).not.toHaveBeenCalled()
  })

  it.each(['stale', 'throwing', 'invalidated'] as const)('discards a helper reply after the session becomes %s', (reason) => {
    const changed = vi.fn(), exporter = createHistoryExport(changed)
    let current = true, throwing = false
    download.mockImplementation((_receipts, guard) => {
      expect(guard!()).toBe(true)
      if (reason === 'stale') current = false
      else if (reason === 'throwing') throwing = true
      else exporter.invalidate()
      expect(guard!()).toBe(false)
      return { status: 'downloadFailed', text: 'PRIVATE_STALE_REPLY' }
    })
    expect(() => exporter.download(entries, () => {
      if (throwing) throw new Error('PRIVATE_CURRENT_SECRET')
      return current
    })).not.toThrow()
    expect(download).toHaveBeenCalledTimes(1)
    expect(changed).not.toHaveBeenCalled()
  })

  it('publishes no feedback when the guarded helper returns no reply', () => {
    const changed = vi.fn()
    download.mockReturnValue(undefined)
    createHistoryExport(changed).download(entries, () => true)
    expect(download).toHaveBeenCalledTimes(1)
    expect(changed).not.toHaveBeenCalled()
  })

  it.each(['downloadRequested', 'downloadFailed'] as const)('never lets a late clipboard reply replace %s', async (status) => {
    for (const reply of ['resolved', 'rejected'] as const) {
      const changed = vi.fn(), clipboard = deferredClipboard()
      const result = status === 'downloadRequested' ? { status } : { status, text: exportPublicReceiptHistory(entries)! }
      download.mockReturnValue(result)
      const exporter = createHistoryExport(changed)
      const pending = exporter.copy(entries, () => true)
      expect(changed.mock.calls).toEqual([[{ status: 'copying' }]])
      exporter.download(entries, () => true)
      expect(download).toHaveBeenLastCalledWith(entries, expect.any(Function))
      expect(changed.mock.calls).toEqual([[{ status: 'copying' }], [result]])
      if (reply === 'resolved') clipboard.resolve()
      else clipboard.reject()
      await pending
      expect(changed.mock.calls).toEqual([[{ status: 'copying' }], [result]])
      expect(clipboard.writeText).toHaveBeenCalledTimes(1)
    }
  })

  it('allows a subsequent copy while the superseded copy is still pending', async () => {
    const changed = vi.fn(), clipboard = deferredClipboard()
    download.mockReturnValue({ status: 'downloadRequested' })
    const exporter = createHistoryExport(changed)
    const first = exporter.copy(entries, () => true)
    exporter.download(entries, () => true)
    clipboard.writeText.mockResolvedValueOnce(undefined)
    await exporter.copy(entries, () => true)
    expect(clipboard.writeText).toHaveBeenCalledTimes(2)
    expect(changed.mock.calls).toEqual([
      [{ status: 'copying' }], [{ status: 'downloadRequested' }], [{ status: 'copying' }], [{ status: 'copied' }],
    ])
    clipboard.reject()
    await first
    expect(changed).toHaveBeenCalledTimes(4)
  })

  it('preserves manual export after a download request', () => {
    const changed = vi.fn(), exporter = createHistoryExport(changed)
    download.mockReturnValue({ status: 'downloadRequested' })
    exporter.download(entries, () => true)
    exporter.manual(entries, () => true)
    expect(changed.mock.calls).toEqual([
      [{ status: 'downloadRequested' }], [{ status: 'manualExport', text: exportPublicReceiptHistory(entries) }],
    ])
    expect(download.mock.calls[0]![1]!()).toBe(false)
  })
})
