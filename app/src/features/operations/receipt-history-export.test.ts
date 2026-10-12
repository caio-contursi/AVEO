import { getAddressDecoder, getBase58Decoder } from '@solana/kit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyPublicReceiptHistory, exportPublicReceiptHistory } from './receipt-export'

const signature = (value: number) => getBase58Decoder().decode(new Uint8Array(64).fill(value))
const receipt = {
  version: 1, signature: signature(1), submittedAt: '2026-10-09T12:01:00.000Z',
  cluster: 'localnet', programId: getAddressDecoder().decode(new Uint8Array(32).fill(7)),
  commitment: 'confirmed', deploymentGeneratedAt: '2026-10-09T12:00:00.000Z',
  rpcFingerprint: 'a'.repeat(64),
}
afterEach(() => vi.unstubAllGlobals())

describe('bounded public history snapshot export', () => {
  it('preserves order and canonical fields without mutating frozen inputs', () => {
    const second = Object.freeze({ ...receipt, signature: signature(2), cluster: 'devnet' })
    const entries = Object.freeze([Object.freeze({ ...receipt }), second])
    const text = exportPublicReceiptHistory(entries)!
    expect(text).toBe(JSON.stringify({ version: 1, kind: 'aveo-public-submission-history', receipts: entries }, null, 2))
    expect(exportPublicReceiptHistory(entries.map((entry) => Object.fromEntries(Object.entries(entry).reverse())))).toBe(text)
    expect(entries[0]).toEqual(receipt)
  })

  it('exports an empty history explicitly without claiming chain confirmation', () => {
    expect(JSON.parse(exportPublicReceiptHistory([])!)).toEqual({ version: 1, kind: 'aveo-public-submission-history', receipts: [] })
  })

  it('strips secrets, plans, raw logs and confirmation claims from every receipt', () => {
    const entries = [1, 2].map((value) => ({ ...receipt, signature: signature(value),
      rpcUrl: 'https://private.invalid/?key=secret', seed: 'secret', logs: ['secret'],
      status: 'confirmed', slot: 99, confirmation: { status: 'confirmed' }, plan: { secret: true },
    }))
    const text = exportPublicReceiptHistory(entries)!
    expect(text).not.toMatch(/secret|private|rpcUrl|seed|logs|confirmation|slot|plan|status/)
    expect(JSON.parse(text).receipts).toHaveLength(2)
  })

  it.each([undefined, null, 'secret', 1, {}, { receipts: [receipt] }])('rejects a non-array input: %j', (input) => {
    expect(exportPublicReceiptHistory(input)).toBeUndefined()
  })

  it.each([null, {}, { ...receipt, signature: 'secret' }, { ...receipt, commitment: 'unknown' },
    { ...receipt, rpcFingerprint: 'https://private.invalid' }, { ...receipt, submittedAt: '2026-02-30T12:00:00Z' },
  ])('rejects the whole history instead of silently exporting a partial subset: %j', (invalid) => {
    expect(exportPublicReceiptHistory([receipt, invalid])).toBeUndefined()
  })

  it('rejects duplicate signatures even with conflicting contexts', () => {
    expect(exportPublicReceiptHistory([receipt, receipt])).toBeUndefined()
    expect(exportPublicReceiptHistory([receipt, { ...receipt, cluster: 'devnet' }])).toBeUndefined()
  })

  it('allows 100 receipts and rejects 101 without truncation', () => {
    const entries = Array.from({ length: 101 }, (_, index) => ({ ...receipt, signature: signature(index + 1) }))
    expect(JSON.parse(exportPublicReceiptHistory(entries.slice(0, 100))!).receipts).toHaveLength(100)
    expect(exportPublicReceiptHistory(entries)).toBeUndefined()
  })

  it('bounds the final readable envelope to exactly 128000 encoded bytes', () => {
    const base = exportPublicReceiptHistory([receipt])!
    const padding = 128_000 - new TextEncoder().encode(base).length
    const entry = { ...receipt, submittedAt: `2026-10-09T12:01:00.000${'0'.repeat(padding)}Z` }
    expect(new TextEncoder().encode(exportPublicReceiptHistory([entry])!).length).toBe(128_000)
    expect(exportPublicReceiptHistory([{ ...entry, submittedAt: entry.submittedAt.replace('Z', '0Z') }])).toBeUndefined()
  })

  it('does not count or serialize discarded arbitrary Unicode fields', () => {
    expect(exportPublicReceiptHistory([{ ...receipt, private: '🔒'.repeat(128_000) }])).toBe(exportPublicReceiptHistory([receipt]))
  })

  it('handles throwing accessors and sparse arrays without exposing their details', () => {
    expect(exportPublicReceiptHistory([{ get version() { throw new Error('secret') } }])).toBeUndefined()
    expect(exportPublicReceiptHistory(new Array(2))).toBeUndefined()
    const entries = new Proxy([receipt], { get() { throw new Error('private') } })
    expect(exportPublicReceiptHistory(entries)).toBeUndefined()
  })
})

describe('user-triggered history clipboard snapshot', () => {
  it('copies sanitized metadata without network, storage mutation or wallet access', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    const forbidden = vi.fn(() => { throw new Error('Forbidden side effect') })
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    vi.stubGlobal('fetch', forbidden)
    vi.stubGlobal('localStorage', { setItem: forbidden, removeItem: forbidden })
    expect(await copyPublicReceiptHistory([receipt])).toEqual({ status: 'copied' })
    expect(writeText).toHaveBeenCalledExactlyOnceWith(exportPublicReceiptHistory([receipt]))
    expect(forbidden).not.toHaveBeenCalled()
  })

  it.each([undefined, {}, { clipboard: {} }])(
    'offers the same manual JSON when clipboard access is unavailable: %j', async (navigator) => {
      vi.stubGlobal('navigator', navigator)
      expect(await copyPublicReceiptHistory([receipt])).toEqual({ status: 'copyFailed', text: exportPublicReceiptHistory([receipt]) })
    },
  )

  it('offers manual JSON when the browser denies reading the clipboard property', async () => {
    vi.stubGlobal('navigator', { get clipboard() { throw new Error('private') } })
    expect(await copyPublicReceiptHistory([receipt])).toEqual({ status: 'copyFailed', text: exportPublicReceiptHistory([receipt]) })
  })

  it('keeps denied clipboard error details out of the result', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('private')) } })
    const result = await copyPublicReceiptHistory([receipt])
    expect(result).toEqual({ status: 'copyFailed', text: exportPublicReceiptHistory([receipt]) })
    expect(JSON.stringify(result)).not.toContain('private')
  })

  it('rejects the whole malformed export before touching the clipboard', async () => {
    const writeText = vi.fn()
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    expect(await copyPublicReceiptHistory([receipt, {}])).toEqual({ status: 'invalidExport' })
    expect(writeText).not.toHaveBeenCalled()
  })

  it('does nothing when the requesting view is no longer current', async () => {
    const writeText = vi.fn()
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    expect(await copyPublicReceiptHistory([receipt], () => false)).toBeUndefined()
    expect(writeText).not.toHaveBeenCalled()
  })

  it('rechecks the requesting snapshot after reading untrusted metadata', async () => {
    let current = true
    const writeText = vi.fn()
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const entry = { ...receipt, get signature() { current = false; return receipt.signature } }
    expect(await copyPublicReceiptHistory([entry], () => current)).toBeUndefined()
    expect(writeText).not.toHaveBeenCalled()
  })

  it.each(['resolve', 'reject'] as const)('discards a late clipboard %s after a history change', async (outcome) => {
    let current = true
    let resolve!: () => void
    let reject!: (error: Error) => void
    vi.stubGlobal('navigator', { clipboard: { writeText: () => new Promise<void>((ok, fail) => { resolve = ok; reject = fail }) } })
    const pending = copyPublicReceiptHistory([receipt], () => current)
    current = false
    if (outcome === 'resolve') resolve()
    else reject(new Error('private'))
    expect(await pending).toBeUndefined()
  })

  it('takes an immutable textual snapshot before clipboard completion', async () => {
    let resolve!: () => void
    const writeText = vi.fn(() => new Promise<void>((done) => { resolve = done }))
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const entries = [receipt]
    const text = exportPublicReceiptHistory(entries)
    const pending = copyPublicReceiptHistory(entries)
    entries.push({ ...receipt, signature: signature(2) })
    resolve()
    expect(await pending).toEqual({ status: 'copied' })
    expect(writeText).toHaveBeenCalledExactlyOnceWith(text)
  })
})
