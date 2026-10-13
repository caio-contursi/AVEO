import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('read-only demo script keeps six steps and honest alternatives', async () => {
  const html = await readFile(new URL('../docs/presentation/aveo-demo-script.en.html', import.meta.url), 'utf8')
  assert.equal([...html.matchAll(/data-step="\d"/g)].length, 6)
  for (const text of ['without connecting a wallet or submitting transactions',
    'not a signed recovery', 'no real KYC', 'data-variant="present"',
    'data-variant="empty"', 'data-variant="unavailable"',
    'aria-pressed="false"', 'http://localhost:5173/#/carteiras']) assert(html.includes(text), text)
  assert(!/<script[^>]+src=|<link[^>]+stylesheet/.test(html), 'Keep the artifact dependency-free')
})
