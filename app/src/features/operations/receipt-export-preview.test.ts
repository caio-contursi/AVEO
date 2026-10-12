import { getAddressDecoder, getBase58Decoder } from '@solana/kit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { exportPublicReceiptHistory, inspectPublicReceiptHistory } from './receipt-export'
import { SubmissionJournal } from './submission-journal'

const maxBytes = 128_000
const invalid = { status: 'invalid', maxBytes }
const utf8Bytes = (text: string) => new TextEncoder().encode(text).length

function receipt(index = 1) {
  return {
    version: 1,
    signature: getBase58Decoder().decode(new Uint8Array(64).fill(index)),
    submittedAt: '2026-10-09T12:01:00.000Z',
    cluster: 'localnet',
    programId: getAddressDecoder().decode(new Uint8Array(32).fill(7)),
    commitment: 'confirmed',
    deploymentGeneratedAt: '2026-10-09T12:00:00.000Z',
    rpcFingerprint: 'a'.repeat(64),
  }
}

function canonicalText(receipts: readonly ReturnType<typeof receipt>[]) {
  return JSON.stringify({ version: 1, kind: 'aveo-public-submission-history', receipts }, null, 2)
}

function historyAtBytes(size: number) {
  const entry = receipt()
  const padding = size - utf8Bytes(canonicalText([entry]))
  // ISO timestamps allow arbitrary fractional precision; every zero adds one real byte.
  return [{ ...entry, submittedAt: `2026-10-09T12:01:00.000${'0'.repeat(padding)}Z` }]
}

afterEach(() => vi.unstubAllGlobals())

describe('public history export preview', () => {
  it('reports an empty history as ready with the exact canonical envelope size', () => {
    const text = canonicalText([])
    expect(inspectPublicReceiptHistory([])).toEqual({ status: 'ready', bytes: utf8Bytes(text), maxBytes })
    expect(exportPublicReceiptHistory([])).toBe(text)
  })

  it('counts the sanitized canonical envelope and preserves receipt order', () => {
    const entries = [receipt(2), receipt(1)]
    const text = canonicalText(entries)
    const reorderedFields = entries.map((entry) => Object.fromEntries(Object.entries(entry).reverse()))
    expect(inspectPublicReceiptHistory(reorderedFields)).toEqual({ status: 'ready', bytes: utf8Bytes(text), maxBytes })
    expect(exportPublicReceiptHistory(reorderedFields)).toBe(text)
    expect(JSON.parse(text).receipts.map((entry: { signature: string }) => entry.signature)).toEqual(entries.map((entry) => entry.signature))
  })

  it.each(['localnet', 'devnet'])('accepts %s with every supported commitment', (cluster) => {
    for (const commitment of ['processed', 'confirmed', 'finalized']) {
      const entries = [{ ...receipt(), cluster, commitment }]
      const text = canonicalText(entries)
      expect(inspectPublicReceiptHistory(entries)).toEqual({ status: 'ready', bytes: utf8Bytes(text), maxBytes })
      expect(exportPublicReceiptHistory(entries)).toBe(text)
    }
  })

  it('strips unknown Unicode, secrets and chain confirmation claims before measuring', () => {
    const entries = [receipt(1), receipt(2)]
    const untrusted = entries.map((entry) => ({ ...entry,
      rpcUrl: 'https://private.invalid/?key=secret', seed: 'private', logs: ['private'],
      confirmation: { status: 'confirmed', slot: 42 }, plan: { secret: true },
      status: 'confirmed', transaction: 'private', note: 'ação 🔒'.repeat(40_000),
    }))
    expect(utf8Bytes(JSON.stringify(untrusted))).toBeGreaterThan(maxBytes)
    const text = canonicalText(entries)
    expect(inspectPublicReceiptHistory(untrusted)).toEqual({ status: 'ready', bytes: utf8Bytes(text), maxBytes })
    expect(exportPublicReceiptHistory(untrusted)).toBe(text)
  })

  it('does not read or serialize discarded fields', () => {
    const forbidden = vi.fn(() => { throw new Error('private discarded field') })
    const entries = [{ ...receipt(), get secret() { return forbidden() }, toJSON: forbidden }]
    expect(inspectPublicReceiptHistory(entries)).toEqual({ status: 'ready', bytes: utf8Bytes(canonicalText([receipt()])), maxBytes })
    expect(forbidden).not.toHaveBeenCalled()
  })

  it('leaves frozen receipts, unknown nested fields and the input array unchanged', () => {
    const privateData = Object.freeze({ note: 'private' })
    const first = Object.freeze({ ...receipt(2), privateData })
    const second = Object.freeze(receipt(1))
    const entries = Object.freeze([first, second])
    const before = JSON.stringify(entries)
    expect(inspectPublicReceiptHistory(entries)).toEqual({ status: 'ready', bytes: utf8Bytes(canonicalText([receipt(2), receipt(1)])), maxBytes })
    expect(JSON.stringify(entries)).toBe(before)
    expect(entries[0]).toBe(first)
    expect(entries[1]).toBe(second)
    expect(first.privateData).toBe(privateData)
  })

  it.each([127_999, 128_000, 128_001])('uses the inclusive pretty-export limit at exactly %i UTF-8 bytes', (size) => {
    const entries = historyAtBytes(size)
    const text = canonicalText(entries)
    expect(utf8Bytes(text)).toBe(size)
    expect(inspectPublicReceiptHistory(entries)).toEqual({ status: size <= maxBytes ? 'ready' : 'tooLarge', bytes: size, maxBytes })
    expect(exportPublicReceiptHistory(entries)).toBe(size <= maxBytes ? text : undefined)
  })

  it('reports the actual byte count well beyond the limit instead of clamping it', () => {
    const entries = historyAtBytes(160_000)
    expect(inspectPublicReceiptHistory(entries)).toEqual({ status: 'tooLarge', bytes: 160_000, maxBytes })
    expect(exportPublicReceiptHistory(entries)).toBeUndefined()
  })

  it('classifies a storage-valid compact journal as too large for its pretty export', () => {
    const entries = historyAtBytes(128_001)
    const raw = JSON.stringify(entries)
    expect(utf8Bytes(raw)).toBeLessThan(maxBytes)
    const storage = { getItem: vi.fn(() => raw), setItem: vi.fn() }
    const journal = new SubmissionJournal(storage)
    expect(journal.error).toBeUndefined()
    expect(journal.getSnapshot()).toEqual(entries)
    const readsBefore = storage.getItem.mock.calls.length
    expect(inspectPublicReceiptHistory(journal.getSnapshot())).toEqual({ status: 'tooLarge', bytes: 128_001, maxBytes })
    expect(exportPublicReceiptHistory(journal.getSnapshot())).toBeUndefined()
    expect(storage.getItem).toHaveBeenCalledTimes(readsBefore)
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it('accepts exactly 100 distinct receipts without truncation', () => {
    const entries = Array.from({ length: 100 }, (_, index) => receipt(index + 1))
    const text = canonicalText(entries)
    expect(inspectPublicReceiptHistory(entries)).toEqual({ status: 'ready', bytes: utf8Bytes(text), maxBytes })
    expect(exportPublicReceiptHistory(entries)).toBe(text)
    expect(JSON.parse(text).receipts).toHaveLength(100)
  })

  it('rejects 101 otherwise valid receipts without reporting a partial byte count', () => {
    const entries = Array.from({ length: 101 }, (_, index) => receipt(index + 1))
    expect(inspectPublicReceiptHistory(entries)).toEqual(invalid)
    expect(exportPublicReceiptHistory(entries)).toBeUndefined()
  })

  it.each([
    ['undefined', undefined], ['null', null], ['string', 'private'], ['number', 1],
    ['boolean', true], ['object', {}], ['wrapped history', { receipts: [receipt()] }],
    ['array-like object', { 0: receipt(), length: 1 }], ['set', new Set([receipt()])],
  ])('rejects non-array input: %s', (_label, input) => {
    expect(inspectPublicReceiptHistory(input)).toEqual(invalid)
  })

  it.each([
    ['version', 2], ['version', '1'], ['signature', 'private'], ['signature', '1'.repeat(63)],
    ['signature', 123], ['submittedAt', 'private'], ['submittedAt', '2026-02-30T12:00:00Z'],
    ['submittedAt', '2026-10-09T12:01:00'], ['cluster', 'mainnet'],
    ['programId', 'private'], ['programId', '1'.repeat(31)], ['commitment', 'unknown'],
    ['deploymentGeneratedAt', 'yesterday'], ['deploymentGeneratedAt', '2026-02-30T12:00:00Z'],
    ['rpcFingerprint', 'A'.repeat(64)], ['rpcFingerprint', 'a'.repeat(63)],
    ['rpcFingerprint', 'g'.repeat(64)],
  ])('rejects the whole history for malformed %s = %s', (field, value) => {
    const entries = [receipt(), { ...receipt(2), [field]: value }]
    expect(inspectPublicReceiptHistory(entries)).toEqual(invalid)
    expect(exportPublicReceiptHistory(entries)).toBeUndefined()
  })

  it.each(Object.keys(receipt()))('rejects a missing required field: %s', (field) => {
    const malformed = Object.fromEntries(Object.entries(receipt(2)).filter(([key]) => key !== field))
    expect(inspectPublicReceiptHistory([receipt(), malformed])).toEqual(invalid)
  })

  it.each([null, undefined, {}, [], 'private', 1])('rejects a malformed member without partial data: %j', (member) => {
    expect(inspectPublicReceiptHistory([receipt(), member, receipt(2)])).toEqual(invalid)
  })

  it.each(['identical', 'conflicting context'])('rejects duplicate signatures with %s receipts', (variant) => {
    const duplicate = variant === 'identical' ? receipt() : { ...receipt(), cluster: 'devnet', commitment: 'finalized' }
    expect(inspectPublicReceiptHistory([receipt(), duplicate])).toEqual(invalid)
  })

  it('prioritizes invalid metadata over an oversized valid prefix', () => {
    expect(inspectPublicReceiptHistory([...historyAtBytes(128_001), {}])).toEqual(invalid)
    expect(inspectPublicReceiptHistory([...historyAtBytes(128_001), receipt()])).toEqual(invalid)
  })

  it.each([
    ['all holes', () => new Array(2)],
    ['trailing hole', () => { const entries = [receipt()]; entries.length = 2; return entries }],
    ['leading hole', () => { const entries = new Array(2); entries[1] = receipt(); return entries }],
  ])('rejects sparse arrays: %s', (_label, create) => {
    expect(inspectPublicReceiptHistory(create())).toEqual(invalid)
  })

  it.each(Object.keys(receipt()))('contains a throwing accessor for required field %s', (field) => {
    const entry = { ...receipt(2) }
    Object.defineProperty(entry, field, { enumerable: true, get() { throw new Error('private accessor error') } })
    expect(inspectPublicReceiptHistory([receipt(), entry])).toEqual(invalid)
  })

  it.each([
    ['array proxy', () => new Proxy([receipt()], { get() { throw new Error('private proxy error') } })],
    ['receipt proxy', () => [receipt(), new Proxy(receipt(2), { get() { throw new Error('private proxy error') } })]],
    ['revoked proxy', () => { const { proxy, revoke } = Proxy.revocable([receipt()], {}); revoke(); return proxy }],
    ['array element accessor', () => {
      const entries = [receipt()]
      Object.defineProperty(entries, 0, { get() { throw new Error('private element error') } })
      return entries
    }],
  ])('contains throwing input without exposing an error or partial data: %s', (_label, create) => {
    expect(inspectPublicReceiptHistory(create())).toEqual(invalid)
  })

  it('does not access clipboard, storage, network or wallet APIs in any result state', () => {
    const forbidden = vi.fn(() => { throw new Error('Forbidden preview side effect') })
    vi.stubGlobal('navigator', { get clipboard() { return forbidden() }, get locks() { return forbidden() } })
    vi.stubGlobal('localStorage', { getItem: forbidden, setItem: forbidden, removeItem: forbidden, clear: forbidden })
    vi.stubGlobal('sessionStorage', { getItem: forbidden, setItem: forbidden, removeItem: forbidden, clear: forbidden })
    vi.stubGlobal('fetch', forbidden)
    vi.stubGlobal('XMLHttpRequest', forbidden)
    vi.stubGlobal('WebSocket', forbidden)
    vi.stubGlobal('solana', { connect: forbidden, signTransaction: forbidden, signAndSendTransaction: forbidden })
    expect(inspectPublicReceiptHistory([receipt()])).toEqual({ status: 'ready', bytes: utf8Bytes(canonicalText([receipt()])), maxBytes })
    expect(inspectPublicReceiptHistory(historyAtBytes(128_001))).toEqual({ status: 'tooLarge', bytes: 128_001, maxBytes })
    expect(inspectPublicReceiptHistory([receipt(), {}])).toEqual(invalid)
    expect(inspectPublicReceiptHistory([])).toEqual({ status: 'ready', bytes: utf8Bytes(canonicalText([])), maxBytes })
    expect(forbidden).not.toHaveBeenCalled()
  })
})
