import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { pdfPageCount } from './render-presentation.mjs'

const base = new URL('../docs/presentation/aveo-pitch-v0.3.en', import.meta.url)
const read = suffix => readFile(new URL(base.href + suffix), 'utf8')
test('revised pitch preserves natural founder speech and honest scale/market hooks', async () => {
  const html = await read('.html'); const script = await read('.txt')
  assert.equal((html.match(/class="slide" data-slide=/g) ?? []).length, 6)
  for (const text of ['compliance dad', 'imagine', 'two trillion', 'twenty years', 'ask why']) assert(script.includes(text))
  for (const text of ['illustrative scaling scenario', 'current demonstration uses two',
    'McKinsey, June 2024', 'excludes crypto and stablecoins', 'not Aveo’s revenue',
    'Pricing and demand are unvalidated', 'Wallet and full security acceptance remain open',
    'no independent professional audit']) assert(html.includes(text) || html.toLowerCase().includes(text.toLowerCase()), text)
  const notes = [...html.matchAll(/<p class="notes">([^<]+)<\/p>/g)]
  assert.equal(notes.length, 6)
  for (const note of notes) assert(script.includes(note[1].replaceAll('&amp;', '&')))
  const spoken = script.split(/SLIDE \d\n\n/).slice(1).join(' ')
  assert(spoken.split(/\s+/).length < 370, 'Rehearsal script must stay concise')
})
test('revised six-page PDF is tied to the new source, not the old snapshot', async () => {
  const html = await read('.html'); const receipt = JSON.parse(await read('.receipt.json'))
  const pdf = await readFile(new URL(base.href + '.pdf'))
  const hash = value => createHash('sha256').update(value).digest('hex')
  assert.equal(receipt.version, '0.3'); assert.equal(receipt.sourceSha256, hash(html))
  assert.equal(receipt.pdfSha256, hash(pdf)); assert.equal(pdfPageCount(pdf), 6)
  assert(receipt.layout.every(s => s.fits && s.width === 1280 && s.height === 720))
})
