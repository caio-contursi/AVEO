import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { validateManifest, pdfPageCount } from './render-presentation.mjs'

const root = new URL('../docs/presentation/', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('manifest-v0.1.json', root), 'utf8'))
test('versioned narrative manifest has dated primary sources and safe snapshot names', () => {
  validateManifest(manifest)
  for (const patch of [{ pdf: '../outside.pdf' }, { version: '0.2' }, { pages: 5 }, { language: 'en' }]) {
    assert.throws(() => validateManifest({ ...manifest, ...patch }))
  }
})
test('six self-contained pages preserve material limitations and source links', async () => {
  const html = await readFile(new URL(manifest.source, root), 'utf8')
  assert.equal((html.match(/class="page" data-page=/g) ?? []).length, 6)
  assert(!/<script\b|<iframe\b|<img\b|@import|url\(/i.test(html))
  for (const source of manifest.sources) assert(html.includes(source.url))
  for (const limitation of ['NOT_FULL', 'MPL-3643', 'não é receita', 'Hipótese:', 'auditoria independente', 'Não somar']) {
    assert(html.includes(limitation), limitation)
  }
})
test('PDF page counting does not count Pages tree nodes', () => {
  assert.equal(pdfPageCount(Buffer.from('%PDF-1.7\n/Type /Pages\n/Type /Page\n/Type /Page\n')), 2)
  assert.throws(() => pdfPageCount(Buffer.from('not a PDF')))
})
test('generated PDF and source match the versioned receipt', async () => {
  const html = await readFile(new URL(manifest.source, root))
  const pdf = await readFile(new URL(manifest.pdf, root))
  const receipt = JSON.parse(await readFile(new URL(manifest.receipt, root), 'utf8'))
  const hash = value => createHash('sha256').update(value).digest('hex')
  assert.equal(receipt.sourceSha256, hash(html))
  assert.equal(receipt.pdfSha256, hash(pdf))
  assert.equal(receipt.version, manifest.version)
  assert.equal(receipt.sourceCommit, manifest.sourceCommit)
  assert.equal(pdfPageCount(pdf), 6)
  assert.equal(receipt.layout.length, 6)
  assert(receipt.layout.every(page => page.fits))
})
