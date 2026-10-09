import { getAddressDecoder, getBase58Decoder } from '@solana/kit'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiContext } from '../../api/context'
import { I18nContext } from '../../i18n/context'
import { messages, type Language } from '../../i18n/messages'
import { confirmReceipt, SubmissionHistory, SubmissionReceiptView } from './SubmissionHistory'
import { SubmissionJournal, type SubmissionReceipt } from './submission-journal'

const mocks = vi.hoisted(() => ({
  confirmSignature: vi.fn(), explorerUrl: vi.fn((signature: string) => `https://current-network/tx/${signature}`),
  ctx: null as ApiContext | null, journal: undefined as SubmissionJournal | undefined,
}))
// Any accidental plan, send, readback or wallet import fails: none is provided here.
vi.mock('../../api/transactions', () => ({ confirmSignature: mocks.confirmSignature }))
vi.mock('../../wallet/context', () => ({ useWallet: () => { throw new Error('History must not require a wallet') } }))
vi.mock('../../app/desk', () => ({ useDesk: () => ({ ctx: mocks.ctx, backend: null, explorerUrl: mocks.explorerUrl }) }))
vi.mock('./submission-journal', async (original) => ({
  ...await original<typeof import('./submission-journal')>(), getSubmissionJournal: () => mocks.journal,
}))

const ctx = {
  cluster: 'devnet', commitment: 'confirmed', rpcUrl: 'https://rpc.invalid/?key=private',
  programId: getAddressDecoder().decode(new Uint8Array(32).fill(7)),
  deployment: { generatedAt: '2026-10-09T12:00:00.000Z' },
} as ApiContext
const signature = getBase58Decoder().decode(new Uint8Array(64).fill(1))

function render(element: Parameters<typeof renderToStaticMarkup>[0], language: Language = 'en') {
  return renderToStaticMarkup(createElement(I18nContext.Provider, { value: {
    language, locale: language === 'en' ? 'en-US' : 'pt-BR', setLanguage: () => {},
    t: (key, params = {}) => messages[language][key].replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match),
    has: (key): key is keyof typeof messages.en => key in messages.en,
  } }, element))
}

async function receipt(): Promise<SubmissionReceipt> {
  const journal = new SubmissionJournal({ getItem: () => null, setItem: () => {} })
  await journal.capture(ctx, signature)
  mocks.journal = journal
  return journal.getSnapshot()[0]!
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.ctx = ctx
  mocks.journal = new SubmissionJournal({ getItem: () => null, setItem: () => {} })
  mocks.confirmSignature.mockResolvedValue({ status: 'confirmed', slot: 42, logs: [] })
})

describe('read-only receipt confirmation', () => {
  it('checks the original signature without any backend or wallet', async () => {
    const entry = await receipt()
    expect(await confirmReceipt(ctx, entry, mocks.journal!)).toEqual({
      matches: true, confirmation: { status: 'confirmed', slot: 42, logs: [] },
    })
    expect(mocks.confirmSignature).toHaveBeenCalledExactlyOnceWith(ctx, signature)
  })

  it.each([
    { cluster: 'localnet' }, { commitment: 'finalized' },
    { programId: getAddressDecoder().decode(new Uint8Array(32).fill(8)) },
    { rpcUrl: 'https://other-rpc.invalid' }, { deployment: { generatedAt: '2026-10-09T13:00:00.000Z' } },
  ])('does not query confirmation when scope differs: %j', async (patch) => {
    const entry = await receipt()
    expect(await confirmReceipt({ ...ctx, ...patch } as ApiContext, entry, mocks.journal!)).toEqual({ matches: false })
    expect(mocks.confirmSignature).not.toHaveBeenCalled()
  })

  it('does not start confirmation after navigation while matching is pending', async () => {
    const entry = await receipt()
    let current = true
    let resolve!: (matches: boolean) => void
    const pending = confirmReceipt(ctx, entry, { matches: () => new Promise<boolean>((done) => { resolve = done }) }, () => current)
    current = false
    resolve(true)
    expect(await pending).toBeUndefined()
    expect(mocks.confirmSignature).not.toHaveBeenCalled()
  })

  it('discards late confirmation after a scope change or navigation', async () => {
    const entry = await receipt()
    let current = true
    let resolve!: (result: { status: 'confirmed'; logs: string[] }) => void
    mocks.confirmSignature.mockImplementation(() => new Promise((done) => { resolve = done }))
    const pending = confirmReceipt(ctx, entry, { matches: async () => true }, () => current)
    await Promise.resolve()
    current = false
    resolve({ status: 'confirmed', logs: [] })
    expect(await pending).toBeUndefined()
  })

  it('keeps a failed read unknown and does not expose RPC error details', async () => {
    mocks.confirmSignature.mockRejectedValue(new Error('RPC https://secret.invalid/?key=private'))
    expect(await confirmReceipt(ctx, await receipt(), mocks.journal!)).toEqual({
      matches: true, confirmation: { status: 'unknown', logs: [] },
    })
  })

  it('always reads again and never persists confirmation', async () => {
    const entry = await receipt()
    await confirmReceipt(ctx, entry, mocks.journal!)
    mocks.confirmSignature.mockResolvedValue({ status: 'unknown', logs: [] })
    expect((await confirmReceipt(ctx, entry, mocks.journal!))?.confirmation?.status).toBe('unknown')
    expect(mocks.confirmSignature).toHaveBeenCalledTimes(2)
    expect(mocks.journal!.getSnapshot()[0]).not.toHaveProperty('confirmation')
  })
})

describe('public receipt history markup', () => {
  it.each(['en', 'pt'] as const)('explains untrusted local history and network limits (%s)', async (language) => {
    await receipt()
    const html = render(createElement(SubmissionHistory), language)
    expect(html).toContain(messages[language]['receipts.note'])
    expect(html).toContain(messages[language]['receipts.scopeNote'])
    expect(html).toContain(messages[language]['receipts.exportNote'])
    expect(html).toContain(messages[language]['receipts.copyReceipt'])
    expect(html).toContain(messages[language]['receipts.exportReceipt'])
    expect(html).toContain('aria-live="polite"')
    expect(html).not.toContain('<textarea')
    expect(html).not.toContain('aveo-public-submission-receipt')
    expect(html).toContain(messages[language]['evidence.unknown'])
    expect(html).not.toContain('private')
    expect(mocks.confirmSignature).not.toHaveBeenCalled()
    expect(mocks.explorerUrl).not.toHaveBeenCalled()
  })

  it.each(['storage-unavailable', 'invalid-records', 'storage-full'] as const)('shows a translated static warning for %s', (error) => {
    mocks.journal!.error = error
    const html = render(createElement(SubmissionHistory))
    expect(html).toContain('role="alert"')
    expect(html).toContain(messages.en[`receipts.${error}`])
  })

  it('shows the empty state without requiring a backend', () => {
    expect(render(createElement(SubmissionHistory))).toContain(messages.en['receipts.empty'])
  })

  it('suppresses explorer and localnet labels on mismatch', async () => {
    const html = render(createElement(SubmissionReceiptView, {
      receipt: await receipt(), result: { matches: false, confirmation: { status: 'confirmed', slot: 42, logs: [] } }, busy: false, disabled: false, onRecheck: () => {},
    }))
    expect(html).toContain(messages.en['evidence.contextChanged'])
    expect(html).not.toContain(messages.en['evidence.noExplorer'])
    expect(html).not.toContain('https://current-network')
    expect(html).toContain(messages.en['evidence.unknown'])
    expect(html).not.toContain(messages.en['evidence.confirmed'])
    expect(html).not.toContain('slot 42')
    expect(html).toMatch(/<button type="button" disabled="">/)
    expect(mocks.explorerUrl).not.toHaveBeenCalled()
  })

  it('offers the matched explorer and disables all recheck actions while busy', async () => {
    const html = render(createElement(SubmissionReceiptView, {
      receipt: await receipt(), result: { matches: true }, busy: true, disabled: true, onRecheck: () => {},
    }))
    expect(html).toContain(`https://current-network/tx/${signature}`)
    expect(html).toContain(messages.en['evidence.rechecking'])
    expect(html).toMatch(/<button type="button" disabled="">/)
  })

  it.each(['en', 'pt'] as const)('keeps export enabled on mismatch while verification is disabled (%s)', async (language) => {
    const html = render(createElement(SubmissionReceiptView, {
      receipt: await receipt(), result: { matches: false }, busy: true, disabled: true, onRecheck: () => {},
    }), language)
    expect(html).toContain(`<button type="button">${messages[language]['receipts.copyReceipt']}</button>`)
    expect(html).toContain(`<button type="button">${messages[language]['receipts.exportReceipt']}</button>`)
    expect(html).not.toContain('<textarea')
    expect(mocks.confirmSignature).not.toHaveBeenCalled()
    expect(mocks.explorerUrl).not.toHaveBeenCalled()
  })

  it('renders export actions with no current network or backend', async () => {
    const entry = await receipt()
    mocks.ctx = null
    const html = render(createElement(SubmissionReceiptView, {
      receipt: entry, busy: false, disabled: true, onRecheck: () => {},
    }))
    expect(html).toContain(messages.en['receipts.copyReceipt'])
    expect(html).toContain(messages.en['receipts.exportReceipt'])
    expect(mocks.confirmSignature).not.toHaveBeenCalled()
    expect(mocks.explorerUrl).not.toHaveBeenCalled()
  })
})
