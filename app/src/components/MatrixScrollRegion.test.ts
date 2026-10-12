import { createElement, type FocusEventHandler } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nContext } from '../i18n/context'
import { messages, type Language } from '../i18n/messages'
import { MatrixScrollRegion } from './MatrixScrollRegion'

// SSR markup plus explicitly driven layout callbacks, matching the existing
// component test pattern. Real layout and native keys are browser acceptance.
const mocks = vi.hoisted(() => ({
  overflows: false,
  region: { scrollWidth: 600, clientWidth: 600, querySelector: vi.fn() },
  effects: [] as (() => (() => void) | void)[],
  setState: vi.fn(),
  focus: undefined as FocusEventHandler<HTMLDivElement> | undefined,
}))
vi.mock('react/jsx-dev-runtime', async (original) => {
  const actual = await original<typeof import('react/jsx-dev-runtime')>()
  return { ...actual, jsxDEV: (...args: Parameters<typeof actual.jsxDEV>) => {
    const props = args[1] as { className?: string; onFocusCapture?: FocusEventHandler<HTMLDivElement> }
    if (props.className === 'table-wrap matrix-scroll-region') mocks.focus = props.onFocusCapture
    return actual.jsxDEV(...args)
  } }
})
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>()
  return { ...actual,
    useRef: () => ({ current: mocks.region }),
    useState: () => [mocks.overflows, (value: boolean) => {
      mocks.overflows = value
      mocks.setState(value)
    }],
    useLayoutEffect: (effect: () => (() => void) | void) => { mocks.effects.push(effect) },
  }
})

let resize: () => void
let fontsReady: () => void
let cleanups: (() => void)[]
let table: object
let fonts: EventTarget & { ready: Promise<void> }
const observe = vi.fn()
const disconnect = vi.fn()
const windowEvents = new EventTarget()

function render(language: Language = 'en', label = 'Asset') {
  return renderToStaticMarkup(createElement(I18nContext.Provider, { value: {
    language, locale: language === 'en' ? 'en-US' : 'pt-BR', setLanguage: () => {},
    t: (key) => messages[language][key],
    has: (key): key is keyof typeof messages.en => key in messages.en,
  } }, createElement(MatrixScrollRegion, null,
    createElement('table', null, createElement('caption', null, label)))))
}

function mountEffect() {
  const effect = mocks.effects.pop()!
  const cleanup = effect()
  if (cleanup) cleanups.push(cleanup)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.overflows = false
  mocks.region.scrollWidth = 600
  mocks.region.clientWidth = 600
  mocks.effects = []
  mocks.focus = undefined
  cleanups = []
  table = {}
  mocks.region.querySelector.mockReturnValue(table)
  fonts = Object.assign(new EventTarget(), {
    ready: new Promise<void>((resolve) => { fontsReady = resolve }),
  })
  vi.stubGlobal('window', windowEvents)
  vi.stubGlobal('document', { fonts })
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback }
    observe = observe
    disconnect = disconnect
  })
})

afterEach(() => {
  for (const cleanup of cleanups) cleanup()
  vi.unstubAllGlobals()
})

describe.each(['pt', 'en'] as const)('matrix scroll discovery (%s)', (language) => {
  it('shows no instruction or extra tab stop until actual overflow is measured', () => {
    const html = render(language)
    expect(html).toContain(`role="region" aria-label="${messages[language]['assets.matrixScrollRegion']}"`)
    expect(html).not.toContain('tabindex=')
    expect(html).not.toContain('aria-describedby=')
    expect(html).not.toContain(messages[language]['assets.matrixScrollHint'])
    mountEffect()
    expect(mocks.overflows).toBe(false)
  })

  it('associates the visible translated instruction with the overflowing focusable region', () => {
    mocks.region.scrollWidth = 900
    render(language)
    mountEffect()
    const html = render(language)
    const hintId = html.match(/<p id="([^"]+)" class="matrix-scroll-hint">/)![1]
    expect(html).toContain(messages[language]['assets.matrixScrollHint'])
    expect(html).toContain(`aria-describedby="${hintId}" tabindex="0"`)
    expect(html).toContain('<table><caption>Asset</caption></table>')
    expect(html).not.toContain('role="progressbar"')
  })
})

describe('matrix layout detection', () => {
  it('observes both viewport and table and removes the cue and tab stop when they fit', () => {
    render()
    mountEffect()
    expect(observe.mock.calls).toEqual([[mocks.region], [table]])
    mocks.region.scrollWidth = 901
    resize()
    expect(mocks.overflows).toBe(true)
    mocks.region.clientWidth = 901
    resize()
    const html = render()
    expect(html).not.toContain('matrix-scroll-hint')
    expect(html).not.toContain('aria-describedby=')
    expect(html).not.toContain('tabindex=')
  })

  it('remeasures updated children even when ResizeObserver is unavailable', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    render()
    mountEffect()
    cleanups.pop()!()
    mocks.region.scrollWidth = 1000
    render('pt', 'Updated asset')
    mountEffect()
    expect(mocks.overflows).toBe(true)
    mocks.region.clientWidth = 1000
    windowEvents.dispatchEvent(new Event('resize'))
    expect(mocks.overflows).toBe(false)
  })

  it('remeasures font readiness and subsequent font loads', async () => {
    render()
    mountEffect()
    mocks.region.scrollWidth = 900
    fontsReady()
    await fonts.ready
    expect(mocks.overflows).toBe(true)
    mocks.region.scrollWidth = 600
    fonts.dispatchEvent(new Event('loadingdone'))
    expect(mocks.overflows).toBe(false)
  })

  it('disconnects observers and listeners and ignores delayed measurements after unmount', async () => {
    render()
    mountEffect()
    cleanups.pop()!()
    expect(disconnect).toHaveBeenCalledOnce()
    mocks.setState.mockClear()
    mocks.region.scrollWidth = 900
    resize()
    windowEvents.dispatchEvent(new Event('resize'))
    fonts.dispatchEvent(new Event('loadingdone'))
    fontsReady()
    await fonts.ready
    expect(mocks.setState).not.toHaveBeenCalled()
  })

  it('works without the optional font API', () => {
    vi.stubGlobal('document', {})
    mocks.region.scrollWidth = 900
    render()
    mountEffect()
    expect(mocks.overflows).toBe(true)
  })
})

describe('pinned column focus clearance', () => {
  class Button {
    constructor(readonly cell = true) {}
    classList = { contains: (name: string) => name === 'cell' && this.cell }
    scrollIntoView = vi.fn()
  }

  function focus(target: object) {
    vi.stubGlobal('HTMLButtonElement', Button)
    mocks.focus!({ target } as Parameters<FocusEventHandler<HTMLDivElement>>[0])
  }

  it('aligns an overflowing diagnosis next to the pinned wallet without smooth motion', () => {
    mocks.overflows = true
    render()
    const target = new Button()
    focus(target)
    expect(target.scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: 'nearest', inline: 'start', behavior: 'instant' })
  })

  it('does not reposition controls when the matrix fits', () => {
    render()
    const target = new Button()
    focus(target)
    expect(target.scrollIntoView).not.toHaveBeenCalled()
  })

  it('ignores region focus and non-diagnosis buttons', () => {
    mocks.overflows = true
    render()
    const target = new Button(false)
    focus(target)
    focus({})
    expect(target.scrollIntoView).not.toHaveBeenCalled()
  })
})
