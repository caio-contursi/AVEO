import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { pdfPageCount } from './render-presentation.mjs'

const base = new URL('../docs/presentation/aveo-pitch-v0.4.en', import.meta.url)
const read = suffix => readFile(new URL(base.href + suffix), 'utf8')
test('juror-focused pitch answers objections without inventing validation', async () => {
  const html = await read('.html'); const script = await read('.txt')
  for (const text of ['No named operator case', 'Scripts + an explorer', 'no superiority claim',
    'Different adapters', 'EVM and MPL-3643 integrations are not implemented',
    'Head of operations', 'Price and willingness to pay are unvalidated',
    'six-scene signoff remain open', 'Our collective work',
    'AI-assisted development', 'four Information Systems students']) assert(html.includes(text), text)
  const closing = html.split('data-slide="6"')[1].split('</section>')[0]
  assert(!/Bruno|Caio|project ownership|individual roles/.test(closing), 'Present collective work without individual attribution')
  assert(closing.includes('EXPLORE AVEOPROTOCOL.IO'), 'Keep a clear closing invitation')
  const notes = [...html.matchAll(/<p class="notes">([^<]+)<\/p>/g)]
  assert.equal(notes.length, 6)
  for (const note of notes) assert(script.includes(note[1].replaceAll('&amp;', '&')))
  const spoken = script.split(/SLIDE \d\n\n/).slice(1).join(' ')
  assert(spoken.split(/\s+/).length < 370, 'Keep the spoken pitch concise')
})
test('new snapshot PDF and six layouts match the source', async () => {
  const html = await read('.html'); const receipt = JSON.parse(await read('.receipt.json'))
  const pdf = await readFile(new URL(base.href + '.pdf'))
  const hash = value => createHash('sha256').update(value).digest('hex')
  assert.equal(receipt.version, '0.4'); assert.equal(receipt.sourceSha256, hash(html))
  assert.equal(receipt.pdfSha256, hash(pdf)); assert.equal(pdfPageCount(pdf), 6)
  assert(receipt.layout.every(s => s.fits && s.width === 1280 && s.height === 720))
})
