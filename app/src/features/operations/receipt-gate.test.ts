import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appRoot = new URL('../../../', import.meta.url)
const { scripts } = JSON.parse(readFileSync(new URL('package.json', appRoot), 'utf8')) as {
  scripts: Record<string, string>
}
const operationsPath = 'src/features/operations/'
const operationsTests = readdirSync(new URL(operationsPath, appRoot), { recursive: true, encoding: 'utf8' })
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => `${operationsPath}${name}`)
const receiptFilters = scripts['test:receipts'].split(/\s+/).slice(2)
const selected = (filename: string) => receiptFilters.some((filter) => filename.includes(filter))

describe('receipt readiness gate', () => {
  it('uses the existing runner and preserves the general app checks', () => {
    expect(scripts['test:receipts'].split(/\s+/).slice(0, 2)).toEqual(['vitest', 'run'])
    expect(scripts['typecheck:tests']).toBe('tsc --project tsconfig.test.json')
    expect(scripts.test).toBe('vitest run')
    expect(scripts.build).toBe('tsc -b && vite build')
    expect(scripts.lint).toBe('eslint .')
    expect(receiptFilters).toEqual([
      `${operationsPath}receipt-`,
      `${operationsPath}submission-journal.test.ts`,
      `${operationsPath}SubmissionHistory`,
    ])
  })

  it('selects the receipt contract, boundaries, exports, journal and history consumers on disk', () => {
    const required = [
      'receipt-contract.test.ts',
      'receipt-capacity.test.ts',
      'receipt-limits.test.ts',
      'receipt-export.test.ts',
      'receipt-history-export.test.ts',
      'receipt-export-preview.test.ts',
      'receipt-download.test.ts',
      'submission-journal.test.ts',
      'SubmissionHistory.test.ts',
      'SubmissionHistoryExportPreview.test.ts',
      'SubmissionHistoryDownload.test.ts',
      'receipt-gate.test.ts',
    ].map((name) => `${operationsPath}${name}`)
    expect(operationsTests).toEqual(expect.arrayContaining(required))
    for (const filename of operationsTests) {
      const isReceiptTest = filename.startsWith(`${operationsPath}receipt-`)
        || filename.startsWith(`${operationsPath}SubmissionHistory`)
        || filename === `${operationsPath}submission-journal.test.ts`
      expect(selected(filename), filename).toBe(isReceiptTest)
    }
  })

  it('automatically selects future receipt and history tests while excluding unrelated suites', () => {
    for (const name of ['receipt-future.test.ts', 'SubmissionHistoryFuture.test.ts']) {
      expect(selected(`${operationsPath}${name}`), name).toBe(true)
    }
    for (const name of ['execution.test.ts', 'preparation.test.ts']) {
      const filename = `${operationsPath}${name}`
      expect(operationsTests).toContain(filename)
      expect(selected(filename), filename).toBe(false)
    }
    const incidentTests = readdirSync(new URL('src/features/incidents/', appRoot), { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.test.ts'))
    expect(incidentTests.length).toBeGreaterThan(0)
    for (const name of incidentTests) {
      const filename = `src/features/incidents/${name}`
      expect(selected(filename), filename).toBe(false)
    }
  })
})
