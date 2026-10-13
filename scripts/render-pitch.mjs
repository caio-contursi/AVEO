import assert from 'node:assert/strict'
import { readFile, writeFile, access } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { pdfPageCount } from './render-presentation.mjs'

export async function renderPitch(moduleFile, htmlFile) {
  assert(path.isAbsolute(moduleFile), 'Use the existing isolated Playwright module.')
  assert(htmlFile.endsWith('.en.html'), 'Use a versioned English HTML source.')
  const version = path.basename(htmlFile).match(/-v(\d+\.\d+)\.en\.html$/)?.[1]
  assert(version, 'The source filename must include its snapshot version.')
  const source = path.resolve(htmlFile); const stem = source.slice(0, -5)
  const pdfFile = stem + '.pdf'; const receiptFile = stem + '.receipt.json'
  const screenshots = Array.from({ length: 6 }, (_, i) => `${stem}.slide-${i + 1}.png`)
  for (const file of [pdfFile, receiptFile, ...screenshots]) {
    try { await access(file) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    throw new Error('Snapshot exists; increment the version instead of overwriting it.')
  }
  const html = await readFile(source, 'utf8')
  const { chromium } = await import(pathToFileURL(moduleFile).href)
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.route('**/*', route => route.abort())
    await page.setContent(html, { waitUntil: 'load' })
    await page.emulateMedia({ media: 'print' })
    await page.evaluate(() => document.fonts.ready)
    assert.equal(await page.locator('.slide').count(), 6)
    const layout = await page.locator('.slide').evaluateAll(slides => slides.map(slide => {
      const box = slide.getBoundingClientRect(); const footer = slide.querySelector('.footer').getBoundingClientRect()
      const children = [...slide.children].filter(e => !e.classList.contains('footer') && !e.classList.contains('notes'))
      return { slide: slide.dataset.slide, width: box.width, height: box.height,
        fits: children.every(e => e.getBoundingClientRect().bottom < footer.top)
          && slide.scrollWidth <= box.width && slide.scrollHeight <= box.height }
    }))
    assert(layout.every(s => s.fits && s.width === 1280 && s.height === 720), 'Slide overflow or incorrect aspect ratio')
    for (let i = 0; i < 6; i++) await page.locator('.slide').nth(i).screenshot({ path: screenshots[i] })
    const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true, tagged: true })
    assert.equal(pdfPageCount(pdf), 6)
    const hash = value => createHash('sha256').update(value).digest('hex')
    await writeFile(pdfFile, pdf, { flag: 'wx' })
    await writeFile(receiptFile, JSON.stringify({ language: 'en', version, pages: 6,
      sourceRevision: process.env.AVEO_SOURCE_REVISION ?? 'working-tree', generatedAt: new Date().toISOString(),
      browser: browser.version(), sourceSha256: hash(html), pdfSha256: hash(pdf), layout,
      scope: 'Editorial rendering only; no wallet or blockchain acceptance.',
    }, null, 2) + '\n', { flag: 'wx' })
    await page.emulateMedia({ media: 'screen' })
    await page.keyboard.press('ArrowRight')
    assert.equal(await page.locator('#counter').textContent(), '2 / 6')
    await page.keyboard.press('t')
    assert.equal(await page.locator('#speaker').isVisible(), true)
    assert.equal(await page.locator('#stage').isVisible(), false)
    await page.keyboard.press('Escape')
    assert.equal(await page.locator('#stage').isVisible(), true)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForFunction(() => document.getElementById('stage').getBoundingClientRect().width <= innerWidth - 31)
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile page overflow')
    console.log(JSON.stringify({ pdf: pdfFile, receipt: receiptFile, screenshots, layoutPassed: true,
      keyboardPassed: true, readingModePassed: true, mobilePassed: true }))
  } finally { await browser.close() }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 4, 'Usage: node scripts/render-pitch.mjs <isolated-playwright-module> <versioned.en.html>')
  await renderPitch(process.argv[2], process.argv[3])
}
