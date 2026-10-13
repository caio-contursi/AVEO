import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../', import.meta.url))
const read = (name: string) => readFileSync(path.join(root, name), 'utf8')

describe('submission documentation contract', () => {
  it('keeps a concise canonical English entry with honest acceptance limits', () => {
    const text = read('README.md')
    expect(text.split('\n').length).toBeLessThan(200)
    for (const phrase of ['https://aveoprotocol.io', 'pnpm install --frozen-lockfile',
      'pnpm verify', 'Public self-service onboarding is **not implemented**',
      '**MPL-3643 is not integrated or validated.**', 'not an independently audited',
      'versioned license yet']) expect(text).toContain(phrase)
    expect(read('README.en.md')).toContain('[README](README.md)')
  })
  it('matches the genuine public deployment identity', () => {
    const manifest = JSON.parse(read('config/deployment.devnet.json')) as { programs: { aveoHook: string } }
    expect(read('README.md')).toContain(manifest.programs.aveoHook)
    expect(read('docs/current-status.md')).toContain(manifest.programs.aveoHook)
  })
  it('resolves local links in current documentation', () => {
    for (const name of ['README.md', 'README.en.md', 'docs/current-status.md']) {
      const links = [...read(name).matchAll(/\]\(([^)]+)\)/g)].map(match => match[1]!)
      for (const link of links) {
        if (/^https?:\/\//.test(link) || link.startsWith('#')) continue
        const target = link.split('#')[0]!
        expect(existsSync(path.resolve(root, path.dirname(name), target)), `${name}: ${link}`).toBe(true)
      }
    }
  })
  it('preserves historical notes without treating them as current signoff', () => {
    const history = read('docs/development-history.pt.md')
    expect(history).toContain('Historical development notes')
    expect(history.split('\n').length).toBeGreaterThan(1000)
    expect(read('docs/current-status.md')).toContain('Acceptance still open')
    expect(read('docs/current-status.md')).toContain('PASS/FAIL/NOT_RUN')
  })
})
