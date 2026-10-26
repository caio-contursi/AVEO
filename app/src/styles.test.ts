import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')

function declarations(body: string): Record<string, string> {
  return Object.fromEntries(body.split(';').filter((entry) => entry.includes(':')).map((entry) => {
    const colon = entry.indexOf(':')
    return [entry.slice(0, colon).trim(), entry.slice(colon + 1).trim()]
  }))
}

// Read the authored cascade; this is not a browser layout or computed-style test.
function rule(selector: string, source = css): Record<string, string> {
  const result: Record<string, string> = {}
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (match[1].split(',').some((entry) => entry.trim() === selector)) {
      Object.assign(result, declarations(match[2]))
    }
  }
  expect(Object.keys(result).length, `Missing CSS selector: ${selector}`).toBeGreaterThan(0)
  return result
}

function mediaRules(condition: string): string {
  const start = css.indexOf(`@media (${condition})`)
  expect(start, `Missing media condition: ${condition}`).toBeGreaterThanOrEqual(0)
  const opening = css.indexOf('{', start)
  let depth = 1
  let end = opening + 1
  while (end < css.length && depth > 0) {
    if (css[end] === '{') depth++
    if (css[end] === '}') depth--
    end++
  }
  expect(depth, `Unbalanced media condition: ${condition}`).toBe(0)
  return css.slice(opening + 1, end - 1)
}

const roots = [...css.matchAll(/:root\s*\{([^}]*)\}/g)]
const light = declarations(roots[0][1])
const dark = { ...light, ...declarations(roots[1][1]) }

function resolve(value: string, tokens: Record<string, string>): string {
  const variable = value.match(/^var\((--[\w-]+)\)$/)
  if (!variable) return value
  const resolved = tokens[variable[1]]
  if (!resolved) throw new Error(`Undefined color token: ${variable[1]}`)
  return resolve(resolved, tokens)
}

function luminance(hex: string): number {
  if (!/^#[\da-f]{6}$/i.test(hex)) throw new Error(`Expected opaque six-digit color, got ${hex}`)
  const channels = [1, 3, 5].map((start) => {
    const srgb = Number.parseInt(hex.slice(start, start + 2), 16) / 255
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
  })
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}

function contrast(foreground: string, background: string): number {
  const a = luminance(foreground)
  const b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

function expectContrast(foreground: string, background: string, tokens: Record<string, string>, label: string) {
  const ratio = contrast(resolve(foreground, tokens), resolve(background, tokens))
  expect(ratio, `${label}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5)
}

describe('contrast helper', () => {
  it('matches WCAG reference pairs and rejects insufficient normal-text contrast', () => {
    expect(contrast('#000000', '#ffffff')).toBe(21)
    expect(contrast('#ffffff', '#000000')).toBe(21)
    expect(contrast('#ffffff', '#ffffff')).toBe(1)
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.478, 3)
    expect(contrast('#777777', '#ffffff')).toBeLessThan(4.5)
    expect(() => luminance('transparent')).toThrow('Expected opaque')
  })
})

describe.each([['light', light], ['dark', dark]] as const)('%s theme accessibility', (theme, tokens) => {
  it('keeps normal, muted, link and semantic text readable on console surfaces', () => {
    for (const foreground of ['--text', '--muted', '--accent', '--ok', '--bad', '--warn', '--unknown']) {
      for (const background of ['--bg', '--surface', '--surface-2']) {
        expectContrast(`var(${foreground})`, `var(${background})`, tokens, `${theme} ${foreground} on ${background}`)
      }
    }
    // Normal and muted text also appear inside notices, simulations and selected cells.
    for (const background of ['--accent-soft', '--ok-soft', '--bad-soft', '--warn-soft', '--unknown-soft']) {
      for (const foreground of ['--text', '--muted']) {
        expectContrast(`var(${foreground})`, `var(${background})`, tokens, `${theme} ${foreground} on ${background}`)
      }
    }
  })

  it('checks the actual primary button and current step text/background declarations', () => {
    for (const selector of ['button.primary', '.stepper li.current']) {
      const styles = rule(selector)
      expectContrast(styles.color, styles.background, tokens, `${theme} ${selector}`)
    }
    const button = rule('button')
    expectContrast('var(--text)', button.background, tokens, `${theme} default button`)
    const activeLanguage = rule('.lang button.active')
    expectContrast(activeLanguage.color, activeLanguage.background, tokens, `${theme} language button`)
    expectContrast(rule('button.primary').color, rule('button.primary:hover:not(:disabled)').background, tokens, `${theme} primary hover`)
  })

  it('checks the shell surfaces introduced by the sidebar layout', () => {
    for (const selector of ['.side-nav a.active', '.side-nav a:hover', '.banner', '.filters button.active', '.cell.selected']) {
      const styles = rule(selector)
      expectContrast(styles.color ?? 'var(--text)', styles.background, tokens, `${theme} ${selector}`)
    }
    // Idle navigation and the current network marker sit on the sidebar and header surfaces.
    expectContrast(rule('.side-nav a').color, rule('.sidebar').background, tokens, `${theme} idle navigation`)
    expectContrast(rule(".network-status[data-status='current']").color, rule('.pill').background, tokens, `${theme} current network`)
  })

  it.each(['ok', 'bad', 'warn', 'neutral', 'accent', 'unknown'])('checks the %s badge declarations at normal-text contrast', (tone) => {
    const badge = rule(`.badge.${tone}`)
    expectContrast(badge.color, badge.background, tokens, `${theme} ${tone} badge`)
  })

  it.each(['current', 'complete', 'blocked', 'pending', 'unknown'])('checks the %s workflow state declarations', (status) => {
    const step = rule(`.workflow-step[data-status='${status}']`)
    expectContrast(step.color, step.background, tokens, `${theme} ${status} workflow`)
  })

  it('keeps the focus ring distinguishable from each neutral surface', () => {
    for (const background of ['--bg', '--surface', '--surface-2']) {
      expect(contrast(tokens['--accent'], tokens[background]), `${theme} focus on ${background}`).toBeGreaterThanOrEqual(3)
    }
  })
})

describe('responsive and interaction stylesheet contracts', () => {
  const compact = mediaRules('max-width: 1023px')
  const mobile = mediaRules('max-width: 640px')
  const phone = mediaRules('max-width: 480px')
  const desktop = css.slice(0, css.indexOf('@media (max-width: 1023px)'))

  it('reduces mobile shell and flow spacing while preserving desktop sizing', () => {
    expect(rule('.topbar', mobile).padding).toBe('6px 16px')
    expect(rule('.page-intro', mobile).padding).toBe('20px 0 16px')
    expect(rule('.workflow-steps', mobile)['grid-template-columns']).toBe('minmax(0, 1fr)')
    expect(rule('.workflow-step', mobile)).toMatchObject({
      'grid-template-columns': '24px minmax(0, 1fr) minmax(0, max-content)',
      padding: '6px 8px',
    })
    expect(rule('.workflow-status', mobile)['grid-column']).toBe('3')
    expect(rule('.topbar', desktop).padding).toBe('10px var(--gutter)')
    expect(rule('.page-intro', desktop).padding).toBe('32px 0 var(--space-6)')
    expect(rule('.workflow-steps', desktop)['grid-template-columns']).toContain('repeat(auto-fit,')
    expect(rule('.workflow-status', desktop)['grid-column']).toBe('2')
  })

  it('turns the sidebar into an in-flow panel that leaves the tab order when closed', () => {
    expect(rule('.shell', desktop)['grid-template-columns']).toBe('var(--sidebar-width) minmax(0, 1fr)')
    expect(rule('.menu-toggle', desktop).display).toBe('none')
    expect(rule('.menu-toggle', compact).display).toBe('inline-flex')
    // display: none removes closed links from the tab order; no overlay, so no focus trap is needed.
    expect(rule('.sidebar', compact)).toMatchObject({ display: 'none', position: 'static' })
    expect(rule(".shell[data-menu='open'] .sidebar", compact).display).toBe('flex')
    expect(rule('.shell', compact)['grid-template-areas']).toMatch(/'topbar'\s*'sidebar'\s*'main'/)
  })

  it('wraps all destinations without horizontal scrolling and keeps touch target height', () => {
    expect(Number.parseFloat(rule('.side-nav a', desktop)['min-height'])).toBeGreaterThanOrEqual(44)
    expect(rule('.side-nav', compact)['grid-template-columns']).toBe('repeat(auto-fit, minmax(min(100%, 200px), 1fr))')
    for (const source of [desktop, compact]) {
      for (const property of ['overflow-x', 'white-space']) expect(rule('.side-nav', source)).not.toHaveProperty(property)
    }
  })

  it('shows exactly one refresh control per layout and keeps network state visible on phones', () => {
    expect(rule('.sidebar-footer .refresh', desktop).display).toBe('none')
    expect(rule('.topbar .refresh', compact).display).toBe('none')
    expect(rule('.sidebar-footer .refresh', compact).display).toBe('inline-flex')
    // Only routine detail is visually clipped; it remains announced, and a blocked network keeps its words.
    const clipped = rule(".network-status[data-status='current'] .network-detail", mobile)
    expect(clipped).toMatchObject({ position: 'absolute', clip: 'rect(0, 0, 0, 0)' })
    expect(clipped).not.toHaveProperty('display')
    expect(mobile).not.toContain("[data-status='blocked'] .network-detail")
    expect(rule('.network-cluster')['white-space']).toBe('nowrap')
    expect(rule('.topbar-title', phone).display).toBe('none')
    expect(phone).not.toContain('.network-status')
  })

  it('keeps focus targets, wallet choices and long wallet labels reachable around the sticky header', () => {
    // Layout overwrites the fallback with the measured header height; the stylesheet only reserves it.
    expect(light['--topbar-offset']).toBe('64px')
    expect(rule('html')['scroll-padding-top']).toBe('calc(var(--topbar-offset) + 16px)')
    expect(rule('.menu')).toMatchObject({ 'max-height': 'calc(100dvh - var(--topbar-offset) - 96px)', 'overflow-y': 'auto' })
    // The measured variable must never feed the header's own size, or a wrapped header could not shrink back.
    expect(rule('.topbar', desktop)['min-height']).toBe('64px')
    expect(rule('.topbar', mobile)['min-height']).toBe('56px')
    expect(css.match(/\.topbar\s*\{[^}]*\}/g)?.join('')).not.toContain('--topbar-offset')
    expect(rule('.topbar', mobile)['flex-wrap']).toBe('wrap')
    expect(rule('.topbar-actions', mobile)['flex-wrap']).toBe('wrap')
    expect(css).not.toMatch(/\.wallet-button\s*\{[^}]*white-space: nowrap/)
  })

  it('scrolls the mobile matrix locally with readable columns and intact verdict words', () => {
    expect(rule('.table-wrap', desktop)).toMatchObject({
      'overflow-x': 'auto', 'max-width': '100%', 'min-width': '0',
    })
    expect(rule('.matrix', mobile)['table-layout']).toBe('auto')
    expect(rule('.matrix', mobile)).toMatchObject({ width: 'max-content', 'min-width': '0' })
    expect(rule('.matrix td', mobile)).toMatchObject({ width: 'var(--matrix-asset-width)', 'min-width': 'var(--matrix-asset-width)', 'max-width': 'var(--matrix-asset-width)' })
    expect(rule('.matrix th:first-child', mobile)['min-width']).toBe('var(--matrix-wallet-width)')
    expect(rule('.cell-top', mobile)['flex-wrap']).toBe('wrap')
    expect(rule('.cell-top .badge', mobile)).toMatchObject({
      'white-space': 'nowrap', 'overflow-wrap': 'normal',
    })
  })

  it('keeps the matrix focus ring inside its scroll viewport and its instruction readable', () => {
    expect(rule('.matrix-scroll-region:focus-visible')).toMatchObject({
      outline: '3px solid var(--accent)', 'outline-offset': '-3px',
    })
    const hint = rule('.matrix-scroll-hint')
    for (const tokens of [light, dark]) {
      expectContrast(hint.color, 'var(--surface)', tokens, 'matrix scroll instruction')
    }
    expect(hint).not.toHaveProperty('position')
    expect(hint).not.toHaveProperty('animation')
  })

  it('pins only semantic wallet headers on mobile with an opaque readable surface', () => {
    for (const selector of ['.matrix thead th:first-child', ".matrix tbody th[scope='row']"]) {
      const styles = rule(selector, mobile)
      expect(styles).toMatchObject({
        position: 'sticky', 'inset-inline-start': '0', 'z-index': '1',
        background: 'var(--surface-2)', color: 'var(--muted)',
        'box-shadow': '1px 0 0 var(--border)',
      })
      for (const tokens of [light, dark]) {
        // resolve + luminance reject transparent backgrounds as well as low contrast.
        expectContrast(styles.color, styles.background, tokens, selector)
      }
      for (const property of ['display', 'visibility', 'opacity', 'overflow', 'text-overflow']) {
        expect(styles).not.toHaveProperty(property)
      }
      expect(desktop).not.toContain(selector)
    }
    expect(rule('.matrix td', mobile)).not.toHaveProperty('position')
    expect(rule('.matrix th:first-child', mobile)).toMatchObject({ width: 'var(--matrix-wallet-width)', 'min-width': 'var(--matrix-wallet-width)' })
  })

  it('reserves bounded native focus scroll clearance without reducing verdict touch targets', () => {
    expect(rule('.matrix-scroll-region', mobile)).toMatchObject({
      'scroll-padding-inline-start': 'min(calc(var(--matrix-wallet-width) + 8px), 50%)',
      'scroll-padding-inline-end': '8px',
      '--matrix-wallet-width': '120px',
      '--matrix-asset-width': 'min(220px, calc(100vw - 66px - var(--matrix-wallet-width)))',
    })
    expect(rule('.matrix .cell:focus-visible', mobile)['outline-offset']).toBe('-3px')
    expect(rule('button:focus-visible', desktop).outline).toBe('3px solid var(--accent)')
    expect(rule('button', desktop)['min-height']).toBe('44px')
    expect(rule('.cell', mobile)).not.toHaveProperty('width')
    expect(rule('.cell', mobile)).not.toHaveProperty('min-height')
    expect(rule('.cell-top .badge', mobile)['white-space']).toBe('nowrap')
    expect(desktop).not.toContain('scroll-padding-inline-start')
    expect(desktop).not.toContain('.matrix .cell:focus-visible')
  })

  it('reserves enough verdict space beside a narrower wallet column at 320px', () => {
    const smallest = mediaRules('max-width: 360px')
    expect(rule('.matrix-scroll-region', smallest)['--matrix-wallet-width']).toBe('104px')
    expect(css.indexOf('@media (max-width: 360px)')).toBeGreaterThan(css.indexOf('@media (max-width: 640px)'))
  })

  it('compacts safety content without hiding, truncating or fixing its height', () => {
    for (const selector of ['.banner', '.page-description', '.workflow', '.workflow-head p',
      '.workflow-steps', '.workflow-step', '.workflow-status', '.workflow-summary']) {
      const styles = rule(selector, mobile)
      for (const property of ['height', 'max-height', 'overflow', 'overflow-y', 'text-overflow',
        'clip', 'clip-path', 'line-clamp', '-webkit-line-clamp', 'display', 'visibility']) {
        expect(styles, `${selector} must retain all safety text`).not.toHaveProperty(property)
      }
    }
    expect(rule('.workflow-status', mobile)['overflow-wrap']).toBe('normal')
    expect(rule('button', desktop)['min-height']).toBe('44px')
  })

  it('keeps automatic dark-theme overrides and distinct success/action tones', () => {
    expect(roots).toHaveLength(2)
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root/)
    expect(light['color-scheme']).toBe('light dark')
    for (const tokens of [light, dark]) {
      expect(tokens['--accent']).not.toBe(tokens['--ok'])
      expect(tokens['--accent-soft']).not.toBe(tokens['--ok-soft'])
    }
  })

  it('contains grid children and uses shrinking tracks for forms, workflows and mobile tables', () => {
    for (const selector of ['.grid-2 > *', '.policy-grid > *', '.form-row > *', '.workflow-steps > *']) {
      expect(rule(selector)).toMatchObject({ 'min-width': '0', 'max-width': '100%' })
    }
    for (const width of [160, 170, 280, 300]) {
      expect(css).toContain(`minmax(min(100%, ${width}px), 1fr)`)
    }
    expect(css).toContain('.grid-2, .policy-grid { grid-template-columns: minmax(0, 1fr); }')
    // Mobile overrides must follow the base rules to survive the cascade.
    expect(css.indexOf('@media (max-width: 640px)')).toBeGreaterThan(css.indexOf('.policy-grid {'))
    expect(rule('dl.kv')['grid-template-columns']).toBe('minmax(0, 1fr)')
    expect(rule('table.stack-sm td')['grid-template-columns']).toBe('minmax(0, 96px) minmax(0, 1fr)')
    expect(rule('.table-wrap')).toMatchObject({ 'overflow-x': 'auto', 'max-width': '100%', 'min-width': '0' })
    expect(rule('.actions.decision-actions')['flex-wrap']).toBe('wrap')
    expect(rule('button')).toMatchObject({ 'min-height': '44px', 'white-space': 'normal' })
  })

  it('gives keyboard controls a visible outline and stops movement when requested', () => {
    for (const selector of ['button:focus-visible', 'a:focus-visible', 'select:focus-visible', 'input:focus-visible', 'textarea:focus-visible', 'summary:focus-visible', 'main:focus-visible']) {
      expect(rule(selector)).toMatchObject({ outline: '3px solid var(--accent)', 'outline-offset': '3px' })
    }
    expect(rule('.skip-link:focus').transform).toBe('translateY(0)')
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\*, \*::before, \*::after\s*\{[^}]*animation: none !important;[^}]*transition: none !important;[^}]*scroll-behavior: auto !important;/)
  })

  it('supports grouped fields and markers without adding nested card weight', () => {
    expect(rule('fieldset.field')).toMatchObject({ border: '0', padding: '0', margin: '0', 'min-width': '0' })
    expect(rule('fieldset.field > legend.field-label')).toMatchObject({ padding: '0', 'margin-bottom': 'var(--space-1)' })
    expect(rule('.workflow-number')).toMatchObject({ border: '1px solid currentColor', 'min-height': '24px' })
    expect(rule('.card .decision-panel').background).toBe('transparent')
    expect(rule('.workflow-step[data-status=\'unknown\']').border).toBe('1px dashed var(--unknown)')
    expect(rule('tr.dim td')).not.toHaveProperty('opacity')
  })

  it('keeps unreadable matrix cells legible and the existing AVEO mark aligned with the action palette', () => {
    expect(rule('.cell:disabled')).toMatchObject({ opacity: '1', cursor: 'default' })
    const favicon = readFileSync(new URL('../public/favicon.svg', import.meta.url), 'utf8')
    expect(favicon).toContain(`fill="${light['--accent']}"`)
    expect(favicon).not.toContain('solana')
  })
})
