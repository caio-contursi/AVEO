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
  const mobile = mediaRules('max-width: 640px')
  const narrow = mediaRules('max-width: 520px')
  const desktop = css.slice(0, css.indexOf('@media (max-width: 640px)'))

  it('reduces mobile shell and flow spacing while preserving desktop sizing', () => {
    expect(rule('.topbar', mobile).padding).toBe('12px 0')
    expect(rule('.page-intro', mobile).padding).toBe('16px 0')
    expect(rule('.tabs', mobile)['margin-top']).toBe('12px')
    expect(rule('.workflow-steps', mobile)['grid-template-columns']).toBe('minmax(0, 1fr)')
    expect(rule('.workflow-step', mobile)).toMatchObject({
      'grid-template-columns': '24px minmax(0, 1fr) minmax(0, max-content)',
      padding: '6px 8px',
    })
    expect(rule('.workflow-status', mobile)['grid-column']).toBe('3')
    expect(rule('.topbar', desktop).padding).toBe('24px 0')
    expect(rule('.page-intro', desktop).padding).toBe('clamp(24px, 4vw, 40px) 0 var(--space-6)')
    expect(rule('.workflow-steps', desktop)['grid-template-columns']).toContain('repeat(auto-fit,')
    expect(rule('.workflow-status', desktop)['grid-column']).toBe('2')
  })

  it('wraps whole navigation destinations and retains touch target height', () => {
    expect(rule('.tabs', narrow)['overflow-x']).toBe('visible')
    expect(rule('.tabs a', narrow)).toMatchObject({
      flex: '1 0 auto', 'white-space': 'nowrap', 'overflow-wrap': 'normal',
    })
    expect(Number.parseFloat(rule('.tabs a', desktop)['min-height'])).toBeGreaterThanOrEqual(44)
    expect(rule('.tabs a', narrow)).not.toHaveProperty('min-height')
  })

  it('scrolls the mobile matrix locally with readable columns and intact verdict words', () => {
    expect(rule('.table-wrap', desktop)).toMatchObject({
      'overflow-x': 'auto', 'max-width': '100%', 'min-width': '0',
    })
    expect(rule('.matrix', mobile)['table-layout']).toBe('auto')
    expect(Number.parseFloat(rule('.matrix', mobile)['min-width'])).toBeGreaterThan(320)
    expect(Number.parseFloat(rule('.matrix td', mobile)['min-width'])).toBeGreaterThanOrEqual(200)
    expect(Number.parseFloat(rule('.matrix th:first-child', mobile)['min-width'])).toBeGreaterThanOrEqual(120)
    expect(rule('.cell-top', mobile)['flex-wrap']).toBe('wrap')
    expect(rule('.cell-top .badge', mobile)).toMatchObject({
      'white-space': 'nowrap', 'overflow-wrap': 'normal',
    })
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
