import { getAddressDecoder, getBase58Decoder, signature } from '@solana/kit'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiContext } from '../../api/context'
import { I18nContext, type I18nValue } from '../../i18n/context'
import { messages, type Language } from '../../i18n/messages'
import { PendingSubmission } from './PendingSubmission'
import type { SubmissionIntentSnapshot } from './submission-intent'
import type { SubmissionRecoveryResult } from './submission-recovery'

const mocks = vi.hoisted(() => ({
  ctx: null as ApiContext | null, snapshot: {} as SubmissionIntentSnapshot,
  recover: vi.fn(), subscribe: vi.fn(() => () => {}),
  slots: [] as unknown[], cursor: 0, effects: [] as (() => void)[], cleanups: [] as (() => void)[],
  buttons: [] as { children: string; onClick: () => void; disabled?: boolean; 'aria-busy'?: boolean }[],
  inputs: [] as { readOnly?: boolean; maxLength?: number; onChange: (event: { currentTarget: { value: string } }) => void }[],
}))
vi.mock('./submission-recovery', () => ({ recoverPendingSubmission: mocks.recover }))
vi.mock('./submission-intent', () => ({ getSubmissionIntentStore: () => ({
  getSnapshot: () => mocks.snapshot, subscribe: mocks.subscribe,
}) }))
vi.mock('../../app/desk', () => ({ useDesk: () => ({ ctx: mocks.ctx }) }))
// Exercise real handlers and lifecycle guards with the project's existing hook harness pattern.
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = mocks.cursor++
    if (!(index in mocks.slots)) mocks.slots[index] = typeof initial === 'function' ? initial() : initial
    return [mocks.slots[index], (next: unknown) => { mocks.slots[index] = next }]
  },
  useRef: (initial: unknown) => {
    const index = mocks.cursor++
    if (!(index in mocks.slots)) mocks.slots[index] = { current: initial }
    return mocks.slots[index]
  },
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  useLayoutEffect: (effect: () => (() => void) | void, deps: unknown[]) => {
    const index = mocks.cursor++
    const previous = mocks.slots[index] as unknown[] | undefined
    if (!previous || deps.some((dep, i) => !Object.is(dep, previous[i]))) {
      mocks.slots[index] = deps
      mocks.effects.push(() => { mocks.cleanups[index]?.(); mocks.cleanups[index] = effect() ?? (() => {}) })
    }
  },
}))
vi.mock('react/jsx-dev-runtime', async (original) => {
  const actual = await original<typeof import('react/jsx-dev-runtime')>()
  return { ...actual, jsxDEV: (...args: Parameters<typeof actual.jsxDEV>) => {
    if (args[0] === 'button') mocks.buttons.push(args[1] as typeof mocks.buttons[number])
    if (args[0] === 'input') mocks.inputs.push(args[1] as typeof mocks.inputs[number])
    return actual.jsxDEV(...args)
  } }
})

const context = {
  cluster: 'localnet', rpcUrl: 'https://private.invalid/?secret=hidden', programId: 'program',
  commitment: 'confirmed', deployment: { generatedAt: 'original' },
} as unknown as ApiContext
const intent = {
  version: 1, attemptId: 'original', signer: getAddressDecoder().decode(new Uint8Array(32).fill(7)), kind: 'transfer', contextFingerprint: 'a'.repeat(64),
  phase: 'wallet-invoked', messageFingerprint: 'b'.repeat(64), signature: signature(getBase58Decoder().decode(new Uint8Array(64).fill(1))),
} as const
function render(language: Language = 'en') {
  mocks.cursor = 0; mocks.buttons = []; mocks.inputs = []
  const value: I18nValue = {
    language, locale: language === 'en' ? 'en-US' : 'pt-BR', setLanguage: vi.fn(),
    t: (key) => messages[language][key], has: (key): key is keyof typeof messages.en => key in messages[language],
  }
  const html = renderToStaticMarkup(createElement(I18nContext.Provider, { value }, createElement(PendingSubmission)))
  mocks.effects.splice(0).forEach((effect) => effect())
  return html
}
function deferred() {
  let resolve!: (result: SubmissionRecoveryResult) => void
  let reject!: (error: Error) => void
  const promise = new Promise<SubmissionRecoveryResult>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.ctx = context; mocks.snapshot = { intent }
  mocks.slots = []; mocks.effects = []; mocks.cleanups = []
  mocks.recover.mockResolvedValue({ status: 'unknown' })
})

describe('global pending submission recovery', () => {
  it.each(['pt', 'en'] as const)('shows the initial pending record, read-only signature and honest scope (%s)', (language) => {
    const html = render(language)
    expect(html).toContain(messages[language]['pending.title'])
    expect(html).toContain(messages[language]['pending.readOnly'])
    expect(html).toMatch(/readonly=""/i)
    expect(html).toContain(intent.signature)
    expect(html).toContain('role="status" aria-live="polite" aria-atomic="true"')
    expect(html).not.toMatch(/private\.invalid|secret=hidden/)
    expect(mocks.recover).not.toHaveBeenCalled()
  })
  it('renders nothing for a healthy empty store', () => {
    mocks.snapshot = {}
    expect(render()).toBe('')
  })
  it.each(['storage-unavailable', 'lock-unavailable', 'invalid-record'] as const)('warns without a valid record: %s', (error) => {
    mocks.snapshot = { error }
    expect(render()).toContain(messages.en['pending.storageWarning'])
    expect(mocks.buttons).toHaveLength(0)
  })
  it('keeps a reserved record blocked without recovery controls', () => {
    mocks.snapshot = { intent: { ...intent, phase: 'reserved', messageFingerprint: undefined, signature: undefined } }
    expect(render()).toContain(messages.en['pending.reserved'])
    expect(mocks.buttons).toHaveLength(0)
    expect(mocks.inputs).toHaveLength(0)
  })
  it('requires an explicit bounded wallet-history signature check', async () => {
    mocks.snapshot = { intent: { ...intent, signature: undefined } }
    render()
    expect(mocks.buttons[0].disabled).toBe(true)
    expect(mocks.inputs[0].maxLength).toBe(88)
    mocks.inputs[0].onChange({ currentTarget: { value: 'x'.repeat(100) } })
    render()
    expect(mocks.buttons[0].children).toBe(messages.en['pending.validate'])
    expect(mocks.recover).not.toHaveBeenCalled()
    mocks.buttons[0].onClick()
    await vi.waitFor(() => expect(mocks.recover).toHaveBeenCalledWith(context, expect.objectContaining({ signature: 'x'.repeat(88) })))
  })
  it('disables checking while the original deployment is unavailable', () => {
    mocks.ctx = null
    expect(render()).toContain(messages.en['pending.noContext'])
    expect(mocks.buttons[0].disabled).toBe(true)
    mocks.buttons[0].onClick()
    expect(mocks.recover).not.toHaveBeenCalled()
  })
  it('guards consecutive clicks synchronously and keeps the panel visible while pending', async () => {
    const pending = deferred(); mocks.recover.mockReturnValue(pending.promise)
    render(); const button = mocks.buttons[0]
    button.onClick(); button.onClick()
    expect(mocks.recover).toHaveBeenCalledTimes(1)
    expect(render()).toContain(messages.en['pending.checking'])
    expect(mocks.buttons[0]['aria-busy']).toBe(true)
    mocks.snapshot = {}
    expect(render()).toContain(messages.en['pending.title'])
    pending.resolve({ status: 'confirmed' })
    await vi.waitFor(() => expect(render()).toContain(messages.en['pending.confirmed']))
  })
  it('allows signature attachment updates without invalidating the request', async () => {
    mocks.snapshot = { intent: { ...intent, signature: undefined } }
    const pending = deferred(); mocks.recover.mockReturnValue(pending.promise)
    render(); mocks.inputs[0].onChange({ currentTarget: { value: intent.signature } }); render()
    mocks.buttons[0].onClick()
    const options = mocks.recover.mock.calls[0][1]
    mocks.snapshot = { intent: { ...intent } }
    expect(options.isCurrent()).toBe(true)
    pending.resolve({ status: 'unknown' })
    await vi.waitFor(() => expect(render()).toContain(messages.en['pending.unknown']))
  })
  it.each(['context', 'unmount', 'replacement'] as const)('ignores stale completion after %s', async (change) => {
    const pending = deferred(); mocks.recover.mockReturnValue(pending.promise)
    render(); mocks.buttons[0].onClick()
    const options = mocks.recover.mock.calls[0][1]
    if (change === 'context') { mocks.ctx = { ...context, rpcUrl: 'https://other.invalid' }; render() }
    if (change === 'unmount') mocks.cleanups.forEach((cleanup) => cleanup())
    if (change === 'replacement') mocks.snapshot = { intent: { ...intent, attemptId: 'different' } }
    expect(options.isCurrent()).toBe(false)
    pending.resolve({ status: 'confirmed' })
    await pending.promise; await Promise.resolve()
    expect(render()).not.toContain(messages.en['pending.confirmed'])
  })
  it.each(['confirmed', 'failed', 'unknown', 'context-mismatch', 'invalid-signature', 'blocked', 'stale', 'empty'] as const)(
    'translates controller status %s without exposing endpoint details', async (status) => {
      mocks.recover.mockResolvedValue({ status })
      render(); mocks.buttons[0].onClick()
      await vi.waitFor(() => expect(render()).toContain(messages.en[`pending.${status}`]))
      expect(render('pt')).toContain(messages.pt[`pending.${status}`])
      expect(render()).not.toContain(context.rpcUrl)
    },
  )
  it('reports unexpected checker failure as unresolved and allows another explicit check', async () => {
    mocks.recover.mockRejectedValue(new Error('https://secret.invalid'))
    render(); mocks.buttons[0].onClick()
    await vi.waitFor(() => expect(render()).toContain(messages.en['pending.unknown']))
    expect(render()).not.toContain('secret.invalid')
    expect(mocks.buttons[0]['aria-busy']).toBeUndefined()
  })
})
