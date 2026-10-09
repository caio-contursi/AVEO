import { createElement, type RefObject } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shortAddress } from '../components/format'
import { messages } from '../i18n/messages'
import { WalletMenu } from './WalletMenu'

type ButtonProps = {
  className?: string
  onClick?: () => void | Promise<void>
  ref?: RefObject<HTMLButtonElement | null>
}

const mocks = vi.hoisted(() => ({
  open: false,
  connected: null as null | { kind: 'dev' | 'standard'; address: string; label: string },
  devWalletsEnabled: true,
  devWallets: [
    { id: 'alice', label: 'Alice', address: '11111111111111111111111111111111' },
    { id: 'bob', label: 'Bob', address: '22222222222222222222222222222222' },
  ],
  wallets: [{ name: 'Installed wallet', chains: ['solana:devnet'], icon: '' }],
  isConnecting: false,
  connect: vi.fn(),
  connectDev: vi.fn(),
  disconnect: vi.fn(),
  disconnectStandard: vi.fn(),
  setStandard: vi.fn(),
  signer: vi.fn(() => { throw new Error('Signer bridge must not run in this harness') }),
  setOpen: vi.fn(),
  setSelection: vi.fn(),
  effects: [] as Array<() => void | (() => void)>,
  buttons: [] as ButtonProps[],
}))

// Controlled SSR harness: effects and event handlers run only when a test asks.
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>()
  return {
    ...actual,
    useState: (initial: unknown) => {
      if (initial === false) return [mocks.open, mocks.setOpen]
      if (initial === null) return [null, mocks.setSelection]
      return actual.useState(initial)
    },
    useEffect: (effect: () => void | (() => void)) => { mocks.effects.push(effect) },
  }
})

vi.mock('react/jsx-dev-runtime', async (original) => {
  const actual = await original<typeof import('react/jsx-dev-runtime')>()
  return {
    ...actual,
    jsxDEV: (...args: Parameters<typeof actual.jsxDEV>) => {
      if (args[0] === 'button') mocks.buttons.push(args[1] as ButtonProps)
      return actual.jsxDEV(...args)
    },
  }
})

vi.mock('@solana/react', () => ({ useWalletAccountTransactionSendingSigner: mocks.signer }))
vi.mock('@wallet-standard/react', () => ({
  useWallets: () => mocks.wallets,
  useConnect: () => [mocks.isConnecting, mocks.connect],
  useDisconnect: () => [false, mocks.disconnectStandard],
}))
vi.mock('./context', () => ({ useWallet: () => ({
  chain: 'solana:devnet',
  connected: mocks.connected,
  devWallets: mocks.devWallets,
  devWalletsEnabled: mocks.devWalletsEnabled,
  connectDev: mocks.connectDev,
  disconnect: mocks.disconnect,
  setStandard: mocks.setStandard,
}) }))
vi.mock('../i18n/context', () => ({ useI18n: () => ({
  t: (key: keyof typeof messages.en, params?: Record<string, unknown>) =>
    messages.en[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? `{${name}}`)),
}) }))

function render() {
  mocks.buttons = []
  mocks.effects = []
  return renderToStaticMarkup(createElement(WalletMenu))
}

function expectNoNestedButtons(html: string) {
  let depth = 0
  for (const tag of html.matchAll(/<\/?button\b[^>]*>/g)) {
    depth += tag[0].startsWith('</') ? -1 : 1
    expect(depth).toBeGreaterThanOrEqual(0)
    expect(depth).toBeLessThanOrEqual(1)
  }
  expect(depth).toBe(0)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.open = false
  mocks.connected = null
  mocks.devWalletsEnabled = true
  mocks.isConnecting = false
  mocks.wallets = [{ name: 'Installed wallet', chains: ['solana:devnet'], icon: '' }]
  mocks.connect.mockResolvedValue([])
  mocks.connectDev.mockResolvedValue(undefined)
})
afterEach(() => vi.unstubAllGlobals())

describe('wallet disclosure presentation', () => {
  it.each(['disconnected', 'dev', 'standard'] as const)(
    'renders valid controls for %s, open and closed, with dev wallets enabled and disabled', (kind) => {
      mocks.connected = kind === 'disconnected' ? null : {
        kind, address: mocks.devWallets[0].address, label: 'Selected wallet',
      }
      for (const open of [false, true]) {
        for (const enabled of [false, true]) {
          mocks.open = open
          mocks.devWalletsEnabled = enabled
          const html = render()
          expectNoNestedButtons(html)
          expect(html).toContain(`aria-expanded="${open}"`)
          expect(html).not.toContain('aria-haspopup')
          expect(html).not.toContain('role="menu"')
          const id = html.match(/aria-controls="([^"]+)"/)?.[1]
          expect(id).toBeTruthy()
          expect(html.includes(`id="${id}" role="group" aria-label="${messages.en['wallet.connect']}"`)).toBe(open)
          expect(html.match(/class="copy idle"/g) ?? []).toHaveLength(open && kind !== 'disconnected' ? 1 : 0)
          expect(html.includes('Alice')).toBe(open && enabled)
          expect(html.includes('Bob')).toBe(open && enabled)
          expect(html.includes(messages.en['wallet.disconnect'])).toBe(open && kind !== 'disconnected')
          if (kind !== 'disconnected') {
            expect(html).toContain(`Selected wallet · <span title="${mocks.connected!.address}">${shortAddress(mocks.connected!.address)}</span>`)
          }
          if (open && enabled) {
            expect(html).toContain(`Alice <span title="${mocks.devWallets[0].address}">${shortAddress(mocks.devWallets[0].address)}</span>`)
          }
        }
      }
    },
  )

  it('renders the empty installed-wallet note and filters other chains', () => {
    mocks.open = true
    mocks.wallets = [{ name: 'Other chain wallet', chains: ['eip155:1'], icon: '' }]
    const html = render()
    expect(html).toContain(messages.en['wallet.none'].replace('{chain}', 'solana:devnet'))
    expect(html).not.toContain('Other chain wallet')
    expectNoNestedButtons(html)
  })

  it('keeps an in-progress installed-wallet connection disabled', () => {
    mocks.open = true
    mocks.isConnecting = true
    expect(render()).toMatch(/<button type="button" class="menu-item" disabled="">Installed wallet<\/button>/)
    expect(mocks.connect).not.toHaveBeenCalled()
  })

  it('requires explicit selection to connect and never runs the signer bridge on render or opening', async () => {
    vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
    render()
    mocks.buttons[0].onClick!()
    const toggle = mocks.setOpen.mock.calls[0][0] as (open: boolean) => boolean
    expect(toggle(false)).toBe(true)
    expect(toggle(true)).toBe(false)
    for (const open of [false, true]) {
      mocks.open = open
      render()
      const cleanups = mocks.effects.map((effect) => effect())
      cleanups.forEach((cleanup) => cleanup?.())
    }
    expect(mocks.connect).not.toHaveBeenCalled()
    expect(mocks.connectDev).not.toHaveBeenCalled()
    expect(mocks.signer).not.toHaveBeenCalled()
    expect(mocks.setStandard).not.toHaveBeenCalled()
    await mocks.buttons.find((button) => button.className === 'menu-item')!.onClick!()
    expect(mocks.connect).toHaveBeenCalledOnce()
    expect(mocks.setSelection).not.toHaveBeenCalled()
    await mocks.buttons.find((button) => button.className === 'menu-item ')!.onClick!()
    expect(mocks.connectDev).toHaveBeenCalledExactlyOnceWith('alice')
    expect(mocks.setSelection).toHaveBeenCalledWith(null)
    expect(mocks.setOpen).toHaveBeenCalledWith(false)
    expect(mocks.signer).not.toHaveBeenCalled()
  })

  it('preserves account selection after an explicit installed-wallet connection without invoking the bridge', async () => {
    mocks.open = true
    const account = { address: mocks.devWallets[0].address }
    mocks.connect.mockResolvedValue([account])
    render()
    await mocks.buttons.find((button) => button.className === 'menu-item')!.onClick!()
    expect(mocks.setSelection).toHaveBeenCalledExactlyOnceWith({ wallet: mocks.wallets[0], account })
    expect(mocks.setOpen).toHaveBeenCalledExactlyOnceWith(false)
    expect(mocks.signer).not.toHaveBeenCalled()
    expect(mocks.setStandard).not.toHaveBeenCalled()
  })

  it('preserves Escape focus return and listener cleanup in the controlled harness', () => {
    const listeners = new Map<string, (event: { key?: string; target?: unknown }) => void>()
    const addEventListener = vi.fn((type: string, listener: (event: { key?: string; target?: unknown }) => void) => {
      listeners.set(type, listener)
    })
    const removeEventListener = vi.fn()
    vi.stubGlobal('document', { addEventListener, removeEventListener })
    render()
    mocks.effects.forEach((effect) => effect())
    expect(addEventListener).not.toHaveBeenCalled()
    mocks.open = true
    render()
    const focus = vi.fn()
    mocks.buttons[0].ref!.current = { focus } as unknown as HTMLButtonElement
    const cleanup = mocks.effects[0]()
    listeners.get('keydown')!({ key: 'ArrowDown' })
    expect(mocks.setOpen).not.toHaveBeenCalled()
    listeners.get('keydown')!({ key: 'Escape' })
    expect(mocks.setOpen).toHaveBeenCalledExactlyOnceWith(false)
    expect(focus).toHaveBeenCalledOnce()
    // The outside-click ref is not mounted by SSR; its guard must remain safe.
    listeners.get('mousedown')!({ target: {} })
    expect(mocks.setOpen).toHaveBeenCalledOnce()
    cleanup?.()
    expect(removeEventListener).toHaveBeenCalledWith('mousedown', listeners.get('mousedown'))
    expect(removeEventListener).toHaveBeenCalledWith('keydown', listeners.get('keydown'))
  })
})
