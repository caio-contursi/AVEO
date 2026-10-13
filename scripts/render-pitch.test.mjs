import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { pdfPageCount } from './render-presentation.mjs'

const root = new URL('../docs/presentation/', import.meta.url)
const stem = 'aveo-pitch-v0.2.en'
const html = await readFile(new URL(stem + '.html', root), 'utf8')
test('six English 16:9 slides are self-contained and expose reading controls', () => {
  assert(html.includes('<html lang="en">'))
  assert.equal((html.match(/class="slide" data-slide=/g) ?? []).length, 6)
  assert.equal((html.match(/class="notes"/g) ?? []).length, 6)
  for (const token of ['size:1280px 720px', 'Reading mode', 'Speaker notes', 'ArrowRight', 'Escape']) assert(html.includes(token))
  assert(!/<script[^>]+src=|<iframe|@import|url\(/i.test(html))
})
test('visual tokens match the Aveo light design system', async () => {
  const css = await readFile(new URL('../app/src/styles.css', import.meta.url), 'utf8')
  for (const color of ['#f7f7fa', '#222330', '#606373', '#7030c6', '#dddfe7']) {
    assert(css.includes(color)); assert(html.includes(color))
  }
})
test('commercial and technical limitations remain visible', () => {
  for (const text of ['willingness to pay are unvalidated', 'Synthetic eligibility data',
    'no real KYC', 'no production audit', 'MPL-3643 not integrated',
    'Wallet & full security acceptance pending', 'INDIVIDUAL ROLES REQUIRE TEAM CONFIRMATION']) assert(html.includes(text))
})
test('separate script preserves all six HTML speech blocks', async () => {
  const script = await readFile(new URL(stem + '.txt', root), 'utf8')
  const notes = [...html.matchAll(/<p class="notes">([^<]+)<\/p>/g)]
  assert.equal(notes.length, 6)
  for (const [index, match] of notes.entries()) {
    assert(script.includes(`SLIDE ${index + 1}`)); assert(script.includes(match[1]))
  }
})
test('PDF and rendering receipt match source and preserve six pages', async () => {
  const pdf = await readFile(new URL(stem + '.pdf', root))
  const receipt = JSON.parse(await readFile(new URL(stem + '.receipt.json', root), 'utf8'))
  const hash = value => createHash('sha256').update(value).digest('hex')
  assert.equal(receipt.sourceSha256, hash(html)); assert.equal(receipt.pdfSha256, hash(pdf))
  assert.equal(pdfPageCount(pdf), 6); assert.equal(receipt.language, 'en')
  assert(receipt.layout.every(s => s.fits && s.width === 1280 && s.height === 720))
})
