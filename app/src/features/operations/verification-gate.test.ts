import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const rootPackage = JSON.parse(
  readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8'),
) as { packageManager: string; engines: { node: string }; scripts: Record<string, string> }

const stages = [
  'test:rpc',
  'typecheck',
  '--filter @aveo/app typecheck:tests',
  '--filter @aveo/app lint',
  'test',
  '--filter @aveo/app build',
]
const verifyScript = stages.map((stage) => `pnpm ${stage}`).join(' && ')

function runVerify(failStage = '') {
  // Validate before execution, so only the six expected pnpm commands can run.
  expect(rootPackage.scripts.verify).toBe(verifyScript)
  const fixture = mkdtempSync(join(tmpdir(), 'aveo-verification-gate-'))
  const log = join(fixture, 'stages.log')
  try {
    writeFileSync(log, '')
    writeFileSync(join(fixture, 'pnpm'), `#!/bin/sh
printf '%s\\n' "$*" >> "$AVEO_GATE_LOG"
if [ "$*" = "$AVEO_GATE_FAIL_STAGE" ]; then
  exit 23
fi
exit 0
`, { mode: 0o700 })
    const result = spawnSync('/bin/sh', ['-c', rootPackage.scripts.verify!], {
      cwd: fixture,
      // The fixture is the entire PATH: real pnpm cannot be invoked recursively.
      env: { PATH: fixture, AVEO_GATE_LOG: log, AVEO_GATE_FAIL_STAGE: failStage },
      encoding: 'utf8',
      timeout: 5_000,
    })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
    return { status: result.status, stages: readFileSync(log, 'utf8').trim().split('\n') }
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
}

describe('root verification gate configuration', () => {
  it('runs each required gate once in order with fail-fast chaining', () => {
    // Exact equality excludes watch flags, ignored errors, ||, and extra commands.
    expect(rootPackage.scripts.verify).toBe(verifyScript)
  })

  it('keeps receipt tests as an explicit app wrapper', () => {
    expect(rootPackage.scripts['test:receipts']).toBe('pnpm --filter @aveo/app test:receipts')
  })

  it('preserves the pinned toolchain and existing workspace wrappers', () => {
    expect(rootPackage.packageManager).toBe('pnpm@10.33.3')
    expect(rootPackage.engines.node).toBe('>=22')
    expect(rootPackage.scripts.typecheck).toBe('pnpm -r typecheck')
    expect(rootPackage.scripts.test).toBe('pnpm -r --if-present test')
  })
})

// This fixture exercises Linux /bin/sh semantics; Windows and other platforms skip it.
describe.skipIf(process.platform !== 'linux')('root verification gate execution', () => {
  it('executes all six gates in order when they succeed', () => {
    expect(runVerify()).toEqual({ status: 0, stages })
  })

  it.each(stages)('stops after a failure in %s and returns its nonzero exit code', (stage) => {
    expect(runVerify(stage)).toEqual({
      status: 23,
      stages: stages.slice(0, stages.indexOf(stage) + 1),
    })
  })
})
