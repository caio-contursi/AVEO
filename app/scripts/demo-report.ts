// Generate a public JSON receipt for an actual local acceptance execution.
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { AcceptanceReportBuilder } from './acceptance-report'
import { localArtifactDirectory } from './localnet-safety'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const reportFile = path.join(localArtifactDirectory(appRoot, process.env.AVEO_DEV_DIR), 'acceptance-report.json')
const report = new AcceptanceReportBuilder(new Date().toISOString())
const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/demo-check.ts'], {
  cwd: appRoot,
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
})

const output = createInterface({ input: child.stdout })
const errors = createInterface({ input: child.stderr })
output.on('line', (line) => {
  report.acceptLine(line)
  console.log(line)
})
errors.on('line', (line) => {
  // Runner failures have static messages; discard arbitrary dependency/RPC logs.
  if (line.startsWith('FAIL ')) {
    report.acceptLine(line)
    console.error(line)
  }
})

child.once('error', () => {
  console.error('FAIL demo-report: could not start the local runner')
})
child.once('close', (code) => {
  output.close()
  errors.close()
  const result = report.finish(code, new Date().toISOString())
  try {
    mkdirSync(path.dirname(reportFile), { recursive: true })
    writeFileSync(reportFile, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
    console.log(`${result.status} demo-report: ${reportFile}`)
  } catch {
    console.error('FAIL demo-report: could not write the acceptance receipt')
    process.exitCode = 1
    return
  }
  process.exitCode = result.status === 'PASS' ? 0 : 1
})
