import { getAddressDecoder, getBase58Decoder } from '@solana/kit'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiContext } from '../../api/context'
import { I18nContext } from '../../i18n/context'
import { messages, type Language } from '../../i18n/messages'
import { confirmReceipt, createHistoryExport, createReceiptRemoval, SubmissionHistory, SubmissionHistoryExport, SubmissionReceiptView } from './SubmissionHistory'
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

afterEach(() => { vi.unstubAllGlobals() })

describe('explicit visible history export', () => {
  it.each(['en', 'pt'] as const)('offers manual export without network context and explains snapshot limits (%s)', async (language) => {
    await receipt()
    mocks.ctx = null
    const writeText = vi.fn()
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const html = render(createElement(SubmissionHistory), language)
    expect(html).toContain(messages[language]['receipts.historyExportNote'])
    expect(html).toContain(`<button type="button">${messages[language]['receipts.copyHistory']}</button>`)
    expect(html).toContain(`<button type="button">${messages[language]['receipts.exportHistory']}</button>`)
    expect(html).not.toContain('<textarea')
    expect(html).not.toContain('aveo-public-submission-history')
    expect(writeText).not.toHaveBeenCalled()
    expect(mocks.confirmSignature).not.toHaveBeenCalled()
    expect(mocks.explorerUrl).not.toHaveBeenCalled()
  })

  it.each(['en', 'pt'] as const)('disables both history export actions for an empty snapshot (%s)', (language) => {
    const html = render(createElement(SubmissionHistoryExport, { receipts: [], getSnapshot: () => [] }), language)
    expect(html).toContain(`<button type="button" disabled="">${messages[language]['receipts.copyHistory']}</button>`)
    expect(html).toContain(`<button type="button" disabled="">${messages[language]['receipts.exportHistory']}</button>`)
  })

  it('does nothing until requested and ignores empty or inactive requests', async () => {
    const changed = vi.fn(), writeText = vi.fn()
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const exporter = createHistoryExport(changed), entry = await receipt()
    expect(changed).not.toHaveBeenCalled()
    await exporter.copy([], () => true)
    exporter.manual([], () => true)
    await exporter.copy([entry], () => false)
    exporter.manual([entry], () => false)
    expect(changed).not.toHaveBeenCalled()
    expect(writeText).not.toHaveBeenCalled()
  })

  it('returns sanitized manual JSON without clipboard, wallet or RPC access', async () => {
    const entry = await receipt(), changed = vi.fn(), writeText = vi.fn()
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    createHistoryExport(changed).manual([{ ...entry, rpcUrl: ctx.rpcUrl, confirmation: 'confirmed', keys: ['private'] } as SubmissionReceipt], () => true)
    const state = changed.mock.calls[0]![0]
    expect(state.status).toBe('manualExport')
    expect(JSON.parse(state.text)).toEqual({ version: 1, kind: 'aveo-public-submission-history', receipts: [entry] })
    expect(state.text).not.toContain('private')
    expect(state.text).not.toContain('confirmation')
    expect(state.text).not.toContain('rpcUrl')
    expect(writeText).not.toHaveBeenCalled()
    expect(mocks.confirmSignature).not.toHaveBeenCalled()
  })

  it('offers manual JSON after denied clipboard access', async () => {
    const entry = await receipt(), changed = vi.fn()
    const writeText = vi.fn(async (_text: string) => { throw new Error('private clipboard details') })
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await createHistoryExport(changed).copy([entry], () => true)
    expect(changed.mock.calls[0]).toEqual([{ status: 'copying' }])
    const state = changed.mock.calls[1]![0]
    expect(state.status).toBe('copyFailed')
    expect(state.text).toBe(writeText.mock.calls[0]![0])
    expect(JSON.parse(state.text).receipts).toEqual([entry])
    expect(JSON.stringify(changed.mock.calls)).not.toContain('private clipboard details')
  })

  it('rejects the entire invalid history and leaves the clipboard untouched', async () => {
    const entry = await receipt(), changed = vi.fn(), writeText = vi.fn()
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const exporter = createHistoryExport(changed)
    exporter.manual([entry, entry], () => true)
    expect(changed).toHaveBeenLastCalledWith({ status: 'invalidExport' })
    await exporter.copy([entry, { ...entry, signature: 'invalid' }], () => true)
    expect(changed).toHaveBeenLastCalledWith({ status: 'invalidExport' })
    expect(writeText).not.toHaveBeenCalled()
  })

  it.each(['copied', 'copyFailed'] as const)('discards late %s on navigation, context or snapshot change', async (status) => {
    const entry = await receipt()
    for (const reason of ['navigation', 'context', 'snapshot'] as const) {
      const changed = vi.fn()
      let resolve!: () => void, reject!: (error: Error) => void
      const writeText = vi.fn(() => new Promise<void>((done, fail) => { resolve = done; reject = fail }))
      vi.stubGlobal('navigator', { clipboard: { writeText } })
      let current = true
      const exporter = createHistoryExport(changed)
      const pending = exporter.copy([entry], () => current)
      if (reason === 'snapshot') current = false
      else exporter.invalidate()
      if (status === 'copied') resolve()
      else reject(new Error('private details'))
      await pending
      expect(changed.mock.calls).toEqual([[{ status: 'copying' }]])
    }
  })

  it('guards double clicks and allows manual export to supersede a pending copy', async () => {
    const entry = { ...await receipt() }, changed = vi.fn()
    let resolve!: () => void
    const writeText = vi.fn((_text: string) => new Promise<void>((done) => { resolve = done }))
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const exporter = createHistoryExport(changed), originalTime = entry.submittedAt
    const pending = exporter.copy([entry], () => true)
    await exporter.copy([entry], () => true)
    expect(writeText).toHaveBeenCalledTimes(1)
    entry.submittedAt = '2026-10-10T12:00:00.000Z'
    expect(JSON.parse(writeText.mock.calls[0]![0]).receipts[0].submittedAt).toBe(originalTime)
    exporter.manual([entry], () => true)
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'manualExport' }))
    resolve()
    await pending
    expect(changed).toHaveBeenCalledTimes(2)
    expect(mocks.confirmSignature).not.toHaveBeenCalled()
  })

  it('reports successful copying only for the current snapshot and supports a subsequent request', async () => {
    const entry = await receipt(), changed = vi.fn(), writeText = vi.fn(async (_text: string) => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const exporter = createHistoryExport(changed)
    await exporter.copy([entry], () => true)
    expect(changed.mock.calls).toEqual([[{ status: 'copying' }], [{ status: 'copied' }]])
    await exporter.copy([entry], () => true)
    expect(writeText).toHaveBeenCalledTimes(2)
    expect(changed).toHaveBeenLastCalledWith({ status: 'copied' })
  })
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
    expect(html).toContain(messages[language]['receipts.removeLocal'])
    expect(html).not.toContain(messages[language]['receipts.removeWarning'])
    expect(html).not.toContain(messages[language]['receipts.confirmRemove'])
    expect(html).not.toContain(messages[language]['receipts.cancelRemove'])
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

  it.each(['en', 'pt'] as const)('disables removal without an optional callback and keeps copying available (%s)', async (language) => {
    const html = render(createElement(SubmissionReceiptView, {
      receipt: await receipt(), busy: false, disabled: false, onRecheck: () => {},
    }), language)
    expect(html).toContain(`<button type="button" disabled="">${messages[language]['receipts.removeLocal']}</button>`)
    expect(html).toContain(`<button type="button">${messages[language]['receipts.copyReceipt']}</button>`)
    expect(html).toContain(`<button type="button">${messages[language]['receipts.exportReceipt']}</button>`)
    expect(html).not.toContain(messages[language]['receipts.removeWarning'])
  })

  it.each([undefined, { matches: false }] as const)('allows explicit removal for unknown or mismatched metadata: %j', async (result) => {
    const onRemove = vi.fn(async () => {})
    const html = render(createElement(SubmissionReceiptView, {
      receipt: await receipt(), result, busy: false, disabled: true, onRecheck: () => {}, onRemove,
    }))
    expect(html).toContain(`<button type="button">${messages.en['receipts.removeLocal']}</button>`)
    expect(html).toContain(messages.en['evidence.unknown'])
    expect(html).not.toContain(messages.en['evidence.confirmed'])
    expect(onRemove).not.toHaveBeenCalled()
    expect(mocks.confirmSignature).not.toHaveBeenCalled()
  })

  it.each([{ busy: true }, { busy: false, matching: true }])('disables removal while its receipt is being checked: %j', async (props) => {
    const html = render(createElement(SubmissionReceiptView, {
      receipt: await receipt(), ...props, disabled: false, onRecheck: () => {}, onRemove: async () => {},
    }))
    expect(html).toContain(`<button type="button" disabled="">${messages.en['receipts.removeLocal']}</button>`)
    expect(html).toContain(`<button type="button">${messages.en['receipts.copyReceipt']}</button>`)
  })
})

describe('explicit local receipt removal', () => {
  it('requires the warning step, supports cancel, and never reads the network', async () => {
    const entry = await receipt(), onRemove = vi.fn(async () => {}), changed = vi.fn()
    const removal = createReceiptRemoval(changed)
    await removal.confirm(entry, onRemove, () => true)
    expect(onRemove).not.toHaveBeenCalled()
    removal.request()
    expect(changed).toHaveBeenLastCalledWith('confirming')
    expect(onRemove).not.toHaveBeenCalled()
    removal.cancel()
    expect(changed).toHaveBeenLastCalledWith('idle')
    await removal.confirm(entry, onRemove, () => true)
    expect(onRemove).not.toHaveBeenCalled()
    removal.request()
    await removal.confirm(entry, onRemove, () => true)
    expect(onRemove).toHaveBeenCalledExactlyOnceWith(entry)
    expect(changed).toHaveBeenLastCalledWith('removed')
    expect(mocks.confirmSignature).not.toHaveBeenCalled()
    expect(mocks.explorerUrl).not.toHaveBeenCalled()
  })

  it('guards double submission synchronously and cannot cancel a pending removal', async () => {
    const entry = await receipt(), changed = vi.fn()
    let resolve!: () => void
    const onRemove = vi.fn(() => new Promise<void>((done) => { resolve = done }))
    const removal = createReceiptRemoval(changed)
    removal.request()
    const pending = removal.confirm(entry, onRemove, () => true)
    expect(changed).toHaveBeenLastCalledWith('removing')
    removal.cancel()
    removal.request()
    await removal.confirm(entry, onRemove, () => true)
    expect(changed).toHaveBeenCalledTimes(2)
    expect(onRemove).toHaveBeenCalledExactlyOnceWith(entry)
    resolve()
    await pending
    expect(changed).toHaveBeenLastCalledWith('removed')
    await removal.confirm(entry, onRemove, () => true)
    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(mocks.confirmSignature).not.toHaveBeenCalled()
  })

  it('blocks a check in progress, missing callbacks, and inactive contexts', async () => {
    const entry = await receipt(), onRemove = vi.fn(async () => {}), changed = vi.fn()
    const removal = createReceiptRemoval(changed)
    removal.request(true)
    expect(changed).not.toHaveBeenCalled()
    removal.request()
    await removal.confirm(entry, undefined, () => true)
    await removal.confirm(entry, onRemove, () => false)
    await removal.confirm(entry, onRemove, () => true, true)
    expect(onRemove).not.toHaveBeenCalled()
    expect(changed).toHaveBeenCalledExactlyOnceWith('confirming')
    await removal.confirm(entry, onRemove, () => true)
    expect(onRemove).toHaveBeenCalledExactlyOnceWith(entry)
  })

  it('keeps the receipt on failure and emits only a static error state before explicit retry', async () => {
    const entry = await receipt(), changed = vi.fn()
    const onRemove = vi.fn(async (): Promise<void> => { throw new Error('private storage path and RPC key') })
    const removal = createReceiptRemoval(changed)
    removal.request()
    await removal.confirm(entry, onRemove, () => true)
    expect(changed).toHaveBeenLastCalledWith('removeFailed')
    expect(JSON.stringify(changed.mock.calls)).not.toContain('private')
    expect(mocks.journal!.getSnapshot()).toEqual([entry])
    expect(onRemove).toHaveBeenCalledTimes(1)
    onRemove.mockResolvedValueOnce(undefined)
    await removal.confirm(entry, onRemove, () => true)
    expect(onRemove).toHaveBeenCalledTimes(2)
    expect(changed).toHaveBeenLastCalledWith('removed')
    expect(mocks.confirmSignature).not.toHaveBeenCalled()
  })

  it.each(['success', 'failure'] as const)('discards late %s after unmount or a new context generation', async (answer) => {
    const entry = await receipt(), changed = vi.fn()
    let generation = 1
    let resolve!: () => void, reject!: (error: Error) => void
    const removal = createReceiptRemoval(changed)
    removal.request()
    const pending = removal.confirm(entry, () => new Promise<void>((done, fail) => { resolve = done; reject = fail }), () => generation === 1)
    generation = 2
    if (answer === 'success') resolve()
    else reject(new Error('private details'))
    await pending
    expect(changed.mock.calls).toEqual([['confirming'], ['removing']])
    expect(mocks.confirmSignature).not.toHaveBeenCalled()
  })

  it('retains real journal metadata when the removal storage write fails', async () => {
    let stored: string | null = null
    let fail = false
    const journal = new SubmissionJournal({
      getItem: () => stored,
      setItem: (_key, value) => { if (fail) throw new Error('private storage details'); stored = value },
    })
    await journal.capture(ctx, signature)
    const entry = journal.getSnapshot()[0]!, original = stored, changed = vi.fn()
    const removal = createReceiptRemoval(changed)
    fail = true
    removal.request()
    await removal.confirm(entry, (receipt) => journal.remove(receipt.signature), () => true)
    expect(changed).toHaveBeenLastCalledWith('removeFailed')
    expect(journal.getSnapshot()).toEqual([entry])
    expect(stored).toBe(original)
    expect(mocks.confirmSignature).not.toHaveBeenCalled()
  })

  it('keeps independent receipts independent when one removal is pending', async () => {
    const entry = await receipt(), firstChanged = vi.fn(), secondChanged = vi.fn()
    const first = createReceiptRemoval(firstChanged), second = createReceiptRemoval(secondChanged)
    let resolve!: () => void
    first.request()
    const pending = first.confirm(entry, () => new Promise<void>((done) => { resolve = done }), () => true)
    second.request()
    second.cancel()
    expect(secondChanged.mock.calls).toEqual([['confirming'], ['idle']])
    expect(firstChanged).toHaveBeenLastCalledWith('removing')
    resolve()
    await pending
    expect(secondChanged).toHaveBeenLastCalledWith('idle')
  })
})
