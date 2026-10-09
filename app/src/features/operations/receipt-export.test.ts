import { getAddressDecoder, getBase58Decoder } from '@solana/kit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyPublicReceipt, exportPublicReceipt } from './receipt-export'

const receipt = {
  version: 1,
  signature: getBase58Decoder().decode(new Uint8Array(64).fill(1)),
  submittedAt: '2026-10-09T12:01:00.000Z',
  cluster: 'devnet',
  programId: getAddressDecoder().decode(new Uint8Array(32).fill(7)),
  commitment: 'confirmed',
  deploymentGeneratedAt: '2026-10-09T12:00:00.000Z',
  rpcFingerprint: 'a'.repeat(64),
}

afterEach(() => { vi.unstubAllGlobals() })

describe('public receipt export allowlist', () => {
  it('produces a stable readable envelope containing exactly public receipt fields', () => {
    const text = exportPublicReceipt(receipt)!
    expect(text).toBe(JSON.stringify({ version: 1, kind: 'aveo-public-submission-receipt', receipt }, null, 2))
    expect(text).toContain('\n  "version": 1,')
    expect(exportPublicReceipt(Object.fromEntries(Object.entries(receipt).reverse()))).toBe(text)
    expect(JSON.parse(text)).toEqual({ version: 1, kind: 'aveo-public-submission-receipt', receipt })
  })

  it('strips RPC URLs, raw logs, cached confirmations, plans and arbitrary unknown fields', () => {
    const text = exportPublicReceipt({ ...receipt, rpcUrl: 'https://rpc.invalid/?key=secret',
      logs: ['private log'], rawLogs: ['secret'], confirmation: { status: 'confirmed', slot: 42 },
      status: 'confirmed', slot: 42, plan: { secret: true }, transaction: 'secret', extra: 'secret',
    })!
    expect(text).toBe(exportPublicReceipt(receipt))
    expect(text).not.toMatch(/secret|private|rpcUrl|logs|confirmation|slot|plan|transaction/)
  })

  it.each([
    ['version', 2], ['version', '1'], ['signature', 'secret'], ['signature', '1'.repeat(63)],
    ['signature', 123], ['submittedAt', 'https://private.invalid'], ['submittedAt', '2026-02-30T12:00:00Z'],
    ['cluster', 'mainnet'], ['programId', 'secret'], ['programId', '1'.repeat(31)],
    ['commitment', 'unknown'], ['deploymentGeneratedAt', 'yesterday'],
    ['rpcFingerprint', 'https://rpc.invalid/?key=secret'], ['rpcFingerprint', 'A'.repeat(64)],
    ['rpcFingerprint', 'a'.repeat(63)],
  ])('rejects malformed %s without echoing it', (field, value) => {
    expect(exportPublicReceipt({ ...receipt, [field]: value })).toBeUndefined()
  })

  it.each(Object.keys(receipt))('rejects a missing required field: %s', (field) => {
    expect(exportPublicReceipt(Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== field)))).toBeUndefined()
  })

  it.each([undefined, null, [], 'secret', 1])('rejects invalid input: %s', (input) => {
    expect(exportPublicReceipt(input)).toBeUndefined()
  })

  it('handles throwing accessors without exposing their error', () => {
    expect(exportPublicReceipt({ get version() { throw new Error('secret') } })).toBeUndefined()
  })

  it.each(['localnet', 'devnet'])('allows %s and every supported commitment', (cluster) => {
    for (const commitment of ['processed', 'confirmed', 'finalized']) {
      expect(exportPublicReceipt({ ...receipt, cluster, commitment })).toBeDefined()
    }
  })
})

describe('isolated clipboard export', () => {
  it('copies only the validated envelope, with the clipboard as the only external effect', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    const fetch = vi.fn(() => { throw new Error('No query allowed') })
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    expect(await copyPublicReceipt({ ...receipt, rpcUrl: 'secret', confirmation: 'secret', plan: 'secret' })).toEqual({ status: 'copied' })
    expect(writeText).toHaveBeenCalledExactlyOnceWith(exportPublicReceipt(receipt))
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([undefined, {}, { clipboard: {} }])('provides validated manual text when clipboard is unavailable: %j', async (navigator) => {
    vi.stubGlobal('navigator', navigator)
    expect(await copyPublicReceipt(receipt)).toEqual({ status: 'copyFailed', text: exportPublicReceipt(receipt) })
  })

  it('handles denied clipboard and does not echo browser errors', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('secret')) } })
    const result = await copyPublicReceipt(receipt)
    expect(result).toEqual({ status: 'copyFailed', text: exportPublicReceipt(receipt) })
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('handles denied access to the clipboard property', async () => {
    vi.stubGlobal('navigator', { get clipboard() { throw new Error('secret') } })
    expect(await copyPublicReceipt(receipt)).toEqual({ status: 'copyFailed', text: exportPublicReceipt(receipt) })
  })

  it('rejects invalid metadata before touching clipboard', async () => {
    const writeText = vi.fn()
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    expect(await copyPublicReceipt({ ...receipt, programId: 'secret' })).toEqual({ status: 'invalidExport' })
    expect(writeText).not.toHaveBeenCalled()
  })

  it('does not start a copy after unmount', async () => {
    const writeText = vi.fn()
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    expect(await copyPublicReceipt(receipt, () => false)).toBeUndefined()
    expect(writeText).not.toHaveBeenCalled()
  })

  it.each(['resolve', 'reject'] as const)('discards late clipboard %s after unmount', async (outcome) => {
    let current = true
    let resolve!: () => void
    let reject!: (error: Error) => void
    const writeText = vi.fn(() => new Promise<void>((done, failed) => { resolve = done; reject = failed }))
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const pending = copyPublicReceipt(receipt, () => current)
    current = false
    if (outcome === 'resolve') resolve()
    else reject(new Error('secret'))
    expect(await pending).toBeUndefined()
  })
})
