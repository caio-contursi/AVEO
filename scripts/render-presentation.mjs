// Use an already approved isolated Playwright installation; add no workspace dependency.
import assert from 'node:assert/strict'
import { readFile, writeFile, access, mkdtemp } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export function validateManifest(manifest) {
  assert.match(manifest.version, /^\d+\.\d+$/)
  assert.equal(manifest.language, 'pt-BR')
  assert.match(manifest.asOf, /^\d{4}-\d{2}-\d{2}$/)
  assert.match(manifest.sourceCommit, /^[a-f0-9]{7,40}$/)
  assert.equal(manifest.pages, 6)
  for (const [key, suffix] of [['source', '.pt-BR.html'], ['pdf', '.pt-BR.pdf'], ['receipt', '.json']]) {
    assert.equal(typeof manifest[key], 'string')
    assert.equal(path.basename(manifest[key]), manifest[key])
    assert(manifest[key].endsWith(suffix))
    assert(manifest[key].includes(`v${manifest.version}`))
  }
  assert.equal(manifest.sources.length, 3)
  for (const source of manifest.sources) {
    assert.equal(new URL(source.url).protocol, 'https:')
    assert(source.claim && source.checked === manifest.asOf && source.published)
  }
}

export function pdfPageCount(buffer) {
  assert(buffer.subarray(0, 5).equals(Buffer.from('%PDF-')))
  return [...buffer.toString('latin1').matchAll(/\/Type\s*\/Page\b/g)].length
}

async function absent(file) {
  try { await access(file) } catch (error) { if (error.code === 'ENOENT') return; throw error }
  throw new Error('Snapshot already exists; create a new version instead of overwriting it.')
}

export async function render(moduleFile, manifestFile) {
  assert(path.isAbsolute(moduleFile), 'Provide the existing isolated Playwright module path.')
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
  validateManifest(manifest)
  const directory = path.dirname(path.resolve(manifestFile))
  const sourceFile = path.join(directory, manifest.source)
  const pdfFile = path.join(directory, manifest.pdf)
  const receiptFile = path.join(directory, manifest.receipt)
  await absent(pdfFile)
  await absent(receiptFile)
  const html = await readFile(sourceFile, 'utf8')
  const { chromium } = await import(pathToFileURL(moduleFile).href)
  const browser = await chromium.launch({ channel: 'chromium', headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 1200 } })
    // PDF generation does not fetch sources, load remote fonts or contact blockchain RPC.
    await page.route('**/*', route => route.abort())
    await page.setContent(html, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts.ready)
    assert.equal(await page.locator('.page').count(), manifest.pages)
    assert.equal(await page.locator('script, img, iframe').count(), 0)
    const layout = await page.locator('.page').evaluateAll(pages => pages.map(section => {
      const box = section.getBoundingClientRect()
      const main = section.querySelector('main').getBoundingClientRect()
      const footer = section.querySelector('.footer').getBoundingClientRect()
      return { page: section.dataset.page, fits: main.bottom < footer.top && section.scrollWidth <= box.width + 1 }
    }))
    assert(layout.every(result => result.fits), 'Content must not overlap a footer or overflow a page.')
    const review = await mkdtemp(path.join(tmpdir(), 'aveo-presentation-review-'))
    const preview = await browser.newPage({ viewport: { width: 900, height: 1200 } })
    await preview.route('**/*', route => route.abort())
    for (let i = 0; i < manifest.pages; i++) {
      // Isolate the preview page to avoid scroll/clipping artifacts in long documents.
      await preview.setContent(html, { waitUntil: 'load' })
      await preview.evaluate(index => {
        document.querySelectorAll('.page').forEach((section, position) => {
          if (position !== index) section.remove()
        })
      }, i)
      await preview.evaluate(() => document.fonts.ready)
      await preview.locator('.page').screenshot({ path: path.join(review, `page-${i + 1}.png`) })
    }
    await preview.close()
    await page.emulateMedia({ media: 'print' })
    const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true, tagged: true })
    assert.equal(pdfPageCount(pdf), manifest.pages)
    const hash = value => createHash('sha256').update(value).digest('hex')
    const receipt = { version: manifest.version, sourceCommit: manifest.sourceCommit,
      generatedAt: new Date().toISOString(), browser: browser.version(), pages: pdfPageCount(pdf),
      sourceSha256: hash(html), pdfSha256: hash(pdf), layout,
      scope: 'Editorial PDF rendering only; no network, wallet or blockchain acceptance.' }
    await writeFile(pdfFile, pdf, { flag: 'wx' })
    await writeFile(receiptFile, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' })
    console.log(JSON.stringify({ pdf: pdfFile, receipt: receiptFile, review, pages: manifest.pages }))
  } finally { await browser.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 4, 'Usage: node render-presentation.mjs <isolated-playwright-module> <manifest>')
  await render(process.argv[2], process.argv[3])
}
