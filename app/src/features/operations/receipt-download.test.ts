import { getAddressDecoder, getBase58Decoder } from '@solana/kit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadPublicReceiptHistory } from './receipt-download'
import { exportPublicReceiptHistory } from './receipt-export'

const NativeBlob = globalThis.Blob
const signature = (value: number) => getBase58Decoder().decode(new Uint8Array(64).fill(value))
const receipt = {
  version: 1, signature: signature(1), submittedAt: '2026-10-09T12:01:00.000Z',
  cluster: 'localnet', programId: getAddressDecoder().decode(new Uint8Array(32).fill(7)),
  commitment: 'confirmed', deploymentGeneratedAt: '2026-10-09T12:00:00.000Z',
  rpcFingerprint: 'a'.repeat(64),
}
const objectUrl = 'blob:aveo-test-public-history'
const fail = () => { throw new Error('private RPC key: secret 🔒') }

function installBrowser() {
  const anchor = { href: '', download: '', hidden: false, click: vi.fn(), remove: vi.fn() }
  const appendChild = vi.fn()
  const createElement = vi.fn(() => anchor)
  const createObjectURL = vi.fn((_blob: Blob) => objectUrl)
  const revokeObjectURL = vi.fn()
  const blob = vi.fn(function (parts: BlobPart[], options: BlobPropertyBag) {
    return new NativeBlob(parts, options)
  })
  vi.stubGlobal('Blob', blob)
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
  vi.stubGlobal('document', { createElement, body: { appendChild } })
  return { anchor, appendChild, createElement, createObjectURL, revokeObjectURL, blob }
}

function atByteLimit() {
  const bytes = new TextEncoder().encode(exportPublicReceiptHistory([receipt])!).length
  return { ...receipt, submittedAt: `2026-10-09T12:01:00.000${'0'.repeat(128_000 - bytes)}Z` }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('public receipt history native download', () => {
  it('requests one synchronous download with the exact sanitized Blob, schema and fixed filename', async () => {
    const browser = installBrowser()
    const entries = Object.freeze([
      Object.freeze({ ...receipt, rpcUrl: 'https://private.invalid/?key=secret', seed: 'secret',
        private: '🔒'.repeat(128_000), logs: ['secret'], plan: { secret: true }, confirmation: { slot: 9 } }),
      Object.freeze({ ...receipt, signature: signature(2), cluster: 'devnet' }),
    ])
    const text = exportPublicReceiptHistory(entries)!
    browser.anchor.click.mockImplementation(() => {
      expect(browser.anchor).toMatchObject({
        href: objectUrl, download: 'aveo-public-submission-history.json', hidden: true,
      })
      expect(browser.appendChild).toHaveBeenCalledExactlyOnceWith(browser.anchor)
      expect(browser.anchor.remove).not.toHaveBeenCalled()
      expect(browser.revokeObjectURL).not.toHaveBeenCalled()
    })

    const result = downloadPublicReceiptHistory(entries)
    expect(result).toEqual({ status: 'downloadRequested' })
    expect(result).not.toBeInstanceOf(Promise)
    expect(browser.blob).toHaveBeenCalledExactlyOnceWith([text], { type: 'application/json;charset=utf-8' })
    expect(browser.createElement).toHaveBeenCalledExactlyOnceWith('a')
    expect(browser.anchor.click).toHaveBeenCalledTimes(1)
    const actualBlob = browser.createObjectURL.mock.calls[0][0] as Blob
    expect(actualBlob).toBeInstanceOf(NativeBlob)
    expect(actualBlob.type).toBe('application/json;charset=utf-8')
    expect(await actualBlob.text()).toBe(text)
    expect(JSON.parse(text)).toEqual({
      version: 1, kind: 'aveo-public-submission-history',
      receipts: [receipt, { ...receipt, signature: signature(2), cluster: 'devnet' }],
    })
    expect(text).not.toMatch(/private|secret|🔒|rpcUrl|seed|logs|plan|confirmation/)
    expect(entries).toHaveLength(2)
    expect(browser.anchor.remove).toHaveBeenCalledTimes(1)
    expect(browser.revokeObjectURL).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(0)
    expect(browser.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(objectUrl)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not access clipboard, storage, network or wallet APIs', () => {
    installBrowser()
    const forbidden = vi.fn(fail)
    vi.stubGlobal('navigator', { get clipboard() { return forbidden() } })
    vi.stubGlobal('fetch', forbidden)
    vi.stubGlobal('XMLHttpRequest', forbidden)
    vi.stubGlobal('WebSocket', forbidden)
    vi.stubGlobal('localStorage', { getItem: forbidden, setItem: forbidden, removeItem: forbidden, clear: forbidden })
    vi.stubGlobal('sessionStorage', { getItem: forbidden, setItem: forbidden, removeItem: forbidden, clear: forbidden })
    vi.stubGlobal('indexedDB', { open: forbidden })
    vi.stubGlobal('window', {
      get solana() { return forbidden() }, get solflare() { return forbidden() },
      get navigator() { return forbidden() }, get localStorage() { return forbidden() },
      get sessionStorage() { return forbidden() }, get fetch() { return forbidden() },
    })
    expect(downloadPublicReceiptHistory([receipt])).toEqual({ status: 'downloadRequested' })
    vi.runAllTimers()
    expect(forbidden).not.toHaveBeenCalled()
  })

  it('allows an empty history at the helper boundary', () => {
    const browser = installBrowser()
    expect(downloadPublicReceiptHistory([])).toEqual({ status: 'downloadRequested' })
    expect(browser.blob).toHaveBeenCalledExactlyOnceWith([exportPublicReceiptHistory([])], { type: 'application/json;charset=utf-8' })
  })

  it('allows exactly 100 unique receipts without truncation', () => {
    const browser = installBrowser()
    const entries = Array.from({ length: 100 }, (_, index) => ({ ...receipt, signature: signature(index + 1) }))
    expect(downloadPublicReceiptHistory(entries)).toEqual({ status: 'downloadRequested' })
    expect(JSON.parse(browser.blob.mock.calls[0][0][0] as string).receipts).toEqual(entries)
  })

  it('allows an envelope of exactly 128000 UTF-8 bytes', () => {
    const browser = installBrowser()
    expect(downloadPublicReceiptHistory([atByteLimit()])).toEqual({ status: 'downloadRequested' })
    const text = browser.blob.mock.calls[0][0][0] as string
    expect(new TextEncoder().encode(text)).toHaveLength(128_000)
  })

  const invalidInputs = [
    undefined, null, {}, 'secret', { receipts: [receipt] }, [receipt, {}],
    [receipt, { ...receipt, signature: 'secret' }],
    [receipt, { ...receipt, rpcFingerprint: 'https://private.invalid' }],
    [receipt, receipt], [receipt, { ...receipt, cluster: 'devnet' }],
    Array.from({ length: 101 }, (_, index) => ({ ...receipt, signature: signature(index + 1) })),
    new Array(2), [{ get version() { return fail() } }],
    new Proxy([receipt], { get: fail }),
  ]
  it.each(invalidInputs.map((input, index) => ({ input, index })))(
    'rejects invalid history case $index before allocating browser resources', ({ input }) => {
      const browser = installBrowser()
      expect(downloadPublicReceiptHistory(input)).toEqual({ status: 'invalidExport' })
      expect(browser.blob).not.toHaveBeenCalled()
      expect(browser.createObjectURL).not.toHaveBeenCalled()
      expect(browser.createElement).not.toHaveBeenCalled()
      expect(browser.appendChild).not.toHaveBeenCalled()
      expect(browser.anchor.click).not.toHaveBeenCalled()
      expect(browser.anchor.remove).not.toHaveBeenCalled()
      expect(browser.revokeObjectURL).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('rejects an envelope one byte above the inclusive bound without allocating anything', () => {
    const browser = installBrowser()
    const entry = atByteLimit()
    entry.submittedAt = entry.submittedAt.replace('Z', '0Z')
    expect(downloadPublicReceiptHistory([entry])).toEqual({ status: 'invalidExport' })
    expect(browser.blob).not.toHaveBeenCalled()
    expect(browser.createObjectURL).not.toHaveBeenCalled()
    expect(browser.createElement).not.toHaveBeenCalled()
  })

  it.each(['stale', 'throwing'] as const)('contains an initially %s current callback without allocation', (kind) => {
    const browser = installBrowser()
    const guard = kind === 'stale' ? () => false : fail
    expect(downloadPublicReceiptHistory([receipt], guard)).toBeUndefined()
    expect(browser.blob).not.toHaveBeenCalled()
    expect(browser.createElement).not.toHaveBeenCalled()
  })

  it.each(['stale', 'throwing'] as const)('contains a guard made %s by a receipt getter before allocation', (kind) => {
    const browser = installBrowser()
    let changed = false
    const entry = { ...receipt, get signature() { changed = true; return receipt.signature } }
    const guard = () => changed ? (kind === 'throwing' ? fail() : false) : true
    expect(downloadPublicReceiptHistory([entry], guard)).toBeUndefined()
    expect(browser.blob).not.toHaveBeenCalled()
    expect(browser.createElement).not.toHaveBeenCalled()
  })

  it.each(['blob', 'url', 'element', 'href', 'download', 'hidden', 'append'] as const)(
    'suppresses a click after %s setup makes the requesting view stale and cleans up', (stage) => {
      const browser = installBrowser()
      let current = true
      const stale = () => { current = false }
      if (stage === 'blob') browser.blob.mockImplementation((parts, options) => { stale(); return new NativeBlob(parts, options) })
      if (stage === 'url') browser.createObjectURL.mockImplementation(() => { stale(); return objectUrl })
      if (stage === 'element') browser.createElement.mockImplementation(() => { stale(); return browser.anchor })
      if (stage === 'href' || stage === 'download' || stage === 'hidden') {
        Object.defineProperty(browser.anchor, stage, { set: stale })
      }
      if (stage === 'append') browser.appendChild.mockImplementation(stale)
      expect(downloadPublicReceiptHistory([receipt], () => current)).toBeUndefined()
      expect(browser.anchor.click).not.toHaveBeenCalled()
      expect(browser.anchor.remove).toHaveBeenCalledTimes(1)
      expect(browser.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(objectUrl)
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('contains a current callback that starts throwing after the anchor is attached', () => {
    const browser = installBrowser()
    let attached = false
    browser.appendChild.mockImplementation(() => { attached = true })
    expect(downloadPublicReceiptHistory([receipt], () => attached ? fail() : true)).toBeUndefined()
    expect(browser.anchor.click).not.toHaveBeenCalled()
    expect(browser.anchor.remove).toHaveBeenCalledTimes(1)
    expect(browser.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(objectUrl)
  })

  it.each(['stale', 'throwing'] as const)('suppresses %s feedback after a click while deferring revocation', (kind) => {
    const browser = installBrowser()
    let clicked = false
    browser.anchor.click.mockImplementation(() => { clicked = true })
    expect(downloadPublicReceiptHistory([receipt], () => clicked ? (kind === 'throwing' ? fail() : false) : true)).toBeUndefined()
    expect(browser.anchor.click).toHaveBeenCalledTimes(1)
    expect(browser.anchor.remove).toHaveBeenCalledTimes(1)
    expect(browser.revokeObjectURL).not.toHaveBeenCalled()
    vi.advanceTimersByTime(0)
    expect(browser.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(objectUrl)
  })

  it.each(['Blob', 'URL', 'createObjectURL', 'document', 'createElement', 'body', 'appendChild', 'click'] as const)(
    'provides identical sanitized manual JSON when native %s is missing', (api) => {
      const browser = installBrowser()
      if (api === 'Blob' || api === 'URL' || api === 'document') vi.stubGlobal(api, undefined)
      if (api === 'createObjectURL') vi.stubGlobal('URL', { revokeObjectURL: browser.revokeObjectURL })
      if (api === 'createElement') vi.stubGlobal('document', { body: { appendChild: browser.appendChild } })
      if (api === 'body') vi.stubGlobal('document', { createElement: browser.createElement })
      if (api === 'appendChild') vi.stubGlobal('document', { createElement: browser.createElement, body: {} })
      if (api === 'click') Object.defineProperty(browser.anchor, 'click', { value: undefined })
      const entries = [{ ...receipt, private: 'secret 🔒' }]
      expect(downloadPublicReceiptHistory(entries)).toEqual({ status: 'downloadFailed', text: exportPublicReceiptHistory(entries) })
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it.each(['blob', 'url', 'document', 'element', 'href', 'download', 'hidden', 'body', 'append', 'click'] as const)(
    'contains denied %s setup/click details and immediately releases allocated resources', (stage) => {
      const browser = installBrowser()
      if (stage === 'blob') browser.blob.mockImplementation(fail)
      if (stage === 'url') browser.createObjectURL.mockImplementation(fail)
      if (stage === 'document') vi.stubGlobal('document', { get createElement() { return fail() } })
      if (stage === 'element') browser.createElement.mockImplementation(fail)
      if (stage === 'href' || stage === 'download' || stage === 'hidden') {
        Object.defineProperty(browser.anchor, stage, { set: fail })
      }
      if (stage === 'body') vi.stubGlobal('document', { createElement: browser.createElement, get body() { return fail() } })
      if (stage === 'append') browser.appendChild.mockImplementation(fail)
      if (stage === 'click') browser.anchor.click.mockImplementation(fail)
      const entries = [{ ...receipt, private: 'secret 🔒' }]
      const result = downloadPublicReceiptHistory(entries)
      expect(result).toEqual({ status: 'downloadFailed', text: exportPublicReceiptHistory(entries) })
      expect(JSON.stringify(result)).not.toMatch(/private|secret|🔒|RPC key/)
      expect(browser.anchor.remove).toHaveBeenCalledTimes(['blob', 'url', 'document', 'element'].includes(stage) ? 0 : 1)
      expect(browser.revokeObjectURL).toHaveBeenCalledTimes(['blob', 'url'].includes(stage) ? 0 : 1)
      if (!['blob', 'url'].includes(stage)) expect(browser.revokeObjectURL).toHaveBeenCalledWith(objectUrl)
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it.each(['stale', 'throwing'] as const)('suppresses fallback if a failed click makes the callback %s', (kind) => {
    const browser = installBrowser()
    let failed = false
    browser.anchor.click.mockImplementation(() => { failed = true; fail() })
    expect(downloadPublicReceiptHistory([receipt], () => failed ? (kind === 'throwing' ? fail() : false) : true)).toBeUndefined()
    expect(browser.anchor.remove).toHaveBeenCalledTimes(1)
    expect(browser.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(objectUrl)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['remove', 'revoke', 'both'] as const)('keeps a requested result when %s cleanup throws', (stage) => {
    const browser = installBrowser()
    if (stage !== 'revoke') browser.anchor.remove.mockImplementation(fail)
    if (stage !== 'remove') browser.revokeObjectURL.mockImplementation(fail)
    expect(downloadPublicReceiptHistory([receipt])).toEqual({ status: 'downloadRequested' })
    expect(browser.anchor.click).toHaveBeenCalledTimes(1)
    expect(browser.anchor.remove).toHaveBeenCalledTimes(1)
    expect(browser.revokeObjectURL).not.toHaveBeenCalled()
    expect(() => vi.runAllTimers()).not.toThrow()
    expect(browser.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(objectUrl)
  })

  it('contains removal and immediate revocation errors after a failed click', () => {
    const browser = installBrowser()
    browser.anchor.click.mockImplementation(fail)
    browser.anchor.remove.mockImplementation(fail)
    browser.revokeObjectURL.mockImplementation(fail)
    expect(downloadPublicReceiptHistory([receipt])).toEqual({ status: 'downloadFailed', text: exportPublicReceiptHistory([receipt]) })
    expect(browser.anchor.remove).toHaveBeenCalledTimes(1)
    expect(browser.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(objectUrl)
  })

  it('keeps the requested result and revokes immediately if scheduling cleanup fails', () => {
    const browser = installBrowser()
    vi.stubGlobal('setTimeout', vi.fn(fail))
    expect(downloadPublicReceiptHistory([receipt])).toEqual({ status: 'downloadRequested' })
    expect(browser.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(objectUrl)
  })
})
