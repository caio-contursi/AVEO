import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

test('the maintained validator explicitly retains enough ledger for the complete local cycle', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'aveo-validator-config-test-'))
  try {
    mkdirSync(path.join(directory, 'out'))
    mkdirSync(path.join(directory, 'bin'))
    writeFileSync(path.join(directory, 'bin', 'solana-test-validator'),
      '#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n', { mode: 0o700 })
    for (const name of ['aveo_hook', 'sas', 'token2022']) {
      writeFileSync(path.join(directory, 'out', `${name}.so`), '')
    }
    const script = fileURLToPath(new URL('../dev/solana/scripts/run-validator.sh', import.meta.url))
    // Stub only the process boundary: execute the real maintained shell script.
    const output = execFileSync('bash', [script], {
      env: { ...process.env, DEV_HOME: directory, PATH: `${path.join(directory, 'bin')}:${process.env.PATH}` },
      encoding: 'utf8',
    })
    const args = output.trim().split('\n')
    expect(args[args.indexOf('--limit-ledger-size') + 1]).toBe('1000000')
    expect(args.filter((argument) => argument === '--limit-ledger-size')).toHaveLength(1)
    expect(args[args.indexOf('--ledger') + 1]).toBe(path.join(directory, 'ledger'))
    expect(args.filter((argument) => argument === '--bpf-program')).toHaveLength(3)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
