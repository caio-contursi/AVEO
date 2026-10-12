import { getAddressDecoder, getBase58Decoder } from '@solana/kit'
import { isValidElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SubmissionHistoryExport, SubmissionReceiptView } from './SubmissionHistory'
import type { SubmissionReceipt } from './submission-journal'

// Exercise the real handlers and their hook state without installing a DOM renderer.
const hooks = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0, effects: [] as (() => void)[], cleanups: [] as (() => void)[],
}))
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = hooks.cursor++
    if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === 'function' ? initial() : initial
    return [hooks.slots[index], (next: unknown) => { hooks.slots[index] = next }]
  },
  useRef: (initial: unknown) => {
    const index = hooks.cursor++
    if (!(index in hooks.slots)) hooks.slots[index] = { current: initial }
    return hooks.slots[index]
  },
  useId: () => 'copy-focus-test',
  useLayoutEffect: (effect: () => (() => void) | void, deps: unknown[]) => {
    const index = hooks.cursor++
    const previous = hooks.slots[index] as unknown[] | undefined
    if (!previous || deps.some((dep, i) => !Object.is(dep, previous[i]))) {
      hooks.slots[index] = deps
      hooks.effects.push(() => {
        hooks.cleanups[index]?.()
        hooks.cleanups[index] = effect() ?? (() => {})
      })
    }
  },
}))
vi.mock('../../i18n/context', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('../../app/desk', () => ({ useDesk: () => ({ explorerUrl: () => null }) }))

const receipt: SubmissionReceipt = {
  version: 1, signature: getBase58Decoder().decode(new Uint8Array(64).fill(1)),
  submittedAt: '2026-10-09T12:01:00.000Z', cluster: 'devnet', commitment: 'confirmed',
  programId: getAddressDecoder().decode(new Uint8Array(32).fill(7)),
  deploymentGeneratedAt: '2026-10-09T12:00:00.000Z', rpcFingerprint: 'a'.repeat(64),
}

type ButtonProps = {
  children?: ReactNode; disabled?: boolean; 'aria-disabled'?: boolean; 'aria-busy'?: boolean
  onClick: () => void; ref?: unknown; tabIndex?: number; autoFocus?: boolean
}

function button(tree: ReactNode, label: string): ButtonProps {
  function find(node: ReactNode): ButtonProps | undefined {
    if (Array.isArray(node)) {
      for (const child of node) { const found = find(child); if (found) return found }
    } else if (isValidElement<{ children?: ReactNode }>(node)) {
      if (node.type === 'button' && node.props.children === label) return node.props as ButtonProps
      return find(node.props.children)
    }
  }
  const found = find(tree)
  if (!found) throw new Error(`Missing button: ${label}`)
  return found
}

function mount(kind: 'history' | 'receipt', receipts: readonly SubmissionReceipt[] = [receipt]) {
  let snapshot = receipts
  const label = kind === 'history' ? 'receipts.copyHistory' : 'receipts.copyReceipt'
  function render() {
    hooks.cursor = 0
    let tree: ReactNode
    if (kind === 'history') tree = SubmissionHistoryExport({ receipts, getSnapshot: () => snapshot })
    else {
      const view = SubmissionReceiptView({ receipt, busy: false, disabled: false, onRecheck: () => {} })
      // The public wrapper keys the inner component by receipt signature.
      tree = (view.type as (props: typeof view.props) => ReactNode)(view.props)
    }
    hooks.effects.splice(0).forEach((effect) => effect())
    return tree
  }
  render()
  return {
    render, copy: () => button(render(), label),
    changeSnapshot: () => { snapshot = [] },
    unmount: () => { hooks.cleanups.forEach((cleanup) => cleanup()) },
  }
}

function deferred() {
  let resolve!: () => void
  let reject!: () => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = () => no(new Error('Clipboard unavailable')) })
  return { promise, resolve, reject }
}

beforeEach(() => {
  hooks.slots = []; hooks.cursor = 0; hooks.effects = []; hooks.cleanups = []
})
afterEach(() => { vi.unstubAllGlobals() })

describe.each(['history', 'receipt'] as const)('%s copy keyboard focus semantics', (kind) => {
  it.each(['resolve', 'reject'] as const)('keeps the copy button enabled and guards double activation until %s', async (settle) => {
    const pending = deferred()
    const writeText = vi.fn(() => pending.promise)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const focus = vi.fn()
    const focusedControl = { focus }
    const document = { activeElement: focusedControl }
    vi.stubGlobal('document', document)
    const view = mount(kind)
    const initial = view.copy()
    expect(initial.disabled).not.toBe(true)
    expect(initial['aria-disabled']).toBeUndefined()
    expect(initial['aria-busy']).toBeUndefined()
    expect(writeText).not.toHaveBeenCalled()
    initial.onClick()
    initial.onClick() // Two events before React commits still hit the synchronous guard.
    const copying = view.copy()
    expect(copying.disabled).not.toBe(true)
    expect(copying['aria-disabled']).toBe(true)
    expect(copying['aria-busy']).toBe(true)
    expect(copying.children).toBe(initial.children)
    expect(copying.ref).toBeUndefined()
    expect(copying.tabIndex).toBeUndefined()
    expect(copying.autoFocus).not.toBe(true)
    copying.onClick()
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(focusedControl)
    expect(focus).not.toHaveBeenCalled()

    // Model the user moving focus while the write is pending; completion must not restore it.
    const nextControl = { focus: vi.fn() }
    document.activeElement = nextControl
    pending[settle]()
    await vi.waitFor(() => expect(view.copy()['aria-busy']).toBeUndefined())
    expect(view.copy()['aria-disabled']).toBeUndefined()
    expect(view.copy().disabled).not.toBe(true)
    expect(document.activeElement).toBe(nextControl)
    expect(focus).not.toHaveBeenCalled()
    expect(nextControl.focus).not.toHaveBeenCalled()
    view.copy().onClick()
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(2))
  })

  it('ignores clipboard completion after the view becomes stale', async () => {
    const pending = deferred()
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(() => pending.promise) } })
    const view = mount(kind)
    view.copy().onClick()
    const stateBefore = [...hooks.slots]
    if (kind === 'history') view.changeSnapshot()
    else view.unmount()
    pending.resolve()
    await pending.promise
    // Drain the clipboard helper and the component continuation.
    await Promise.resolve()
    await Promise.resolve()
    expect(hooks.slots).toEqual(stateBefore)
    expect(view.copy()['aria-busy']).toBe(true)
  })
})

describe('history copy availability and supersession', () => {
  it.each([
    { name: 'empty', receipts: [] },
    { name: 'invalid', receipts: [{ ...receipt, signature: 'invalid' }] },
    { name: 'duplicate', receipts: [receipt, receipt] },
    { name: 'oversized', receipts: [{ ...receipt, submittedAt: `2026-10-09T12:01:00.${'0'.repeat(128000)}Z` }] },
  ])('keeps $name history natively disabled', ({ receipts }) => {
    const view = mount('history', receipts)
    expect(view.copy().disabled).toBe(true)
    expect(view.copy()['aria-busy']).toBeUndefined()
  })

  it('preserves manual supersession and prevents stale completion from unlocking a newer copy', async () => {
    const oldCopy = deferred(), newCopy = deferred()
    const writeText = vi.fn().mockReturnValueOnce(oldCopy.promise).mockReturnValueOnce(newCopy.promise)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const view = mount('history')
    view.copy().onClick()
    const manual = button(view.render(), 'receipts.exportHistory')
    expect(manual.disabled).toBe(false)
    manual.onClick()
    expect(hooks.slots[0]).toMatchObject({ status: 'manualExport' })
    expect(view.copy()['aria-busy']).toBeUndefined()
    view.copy().onClick()
    oldCopy.resolve()
    await oldCopy.promise
    await Promise.resolve()
    await Promise.resolve()
    expect(hooks.slots[0]).toEqual({ status: 'copying' })
    view.copy().onClick()
    expect(writeText).toHaveBeenCalledTimes(2)
    newCopy.resolve()
    await vi.waitFor(() => expect(hooks.slots[0]).toEqual({ status: 'copied' }))
  })
})
