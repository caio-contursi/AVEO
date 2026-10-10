// Synthetic localnet only. The operator owns validator startup and teardown.
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isSignature } from '@solana/kit'
import { DEMO_ACCEPTANCE_MANIFEST } from './acceptance-stages'
import { requireLocalGenesis } from './localnet-safety'

export const MAX_STAGE_MS = 6 * 60_000
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stages = ['fixtures', 'local:recovery', 'demo:report', 'local:recovery:resume'] as const
// Keep the existing export as an alias of the producer's immutable contract.
export const EXPECTED_DEMO_STAGE_IDS = DEMO_ACCEPTANCE_MANIFEST.stageIds
type Stage = typeof stages[number]
const scripts: Record<Stage, string> = {
  fixtures: 'fixtures.ts', 'local:recovery': 'local-recovery-check.ts',
  'demo:report': 'demo-report.ts', 'local:recovery:resume': 'local-recovery-resume.ts',
}
const failure = () => new Error('Local cycle failed; inspect the private cycle report and approved validator prerequisites.')
function check(value: unknown): asserts value { if (!value) throw failure() }
function object(value: unknown): Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}
function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

export function cycleEndpoints(env: NodeJS.ProcessEnv) {
  const rpc = env.AVEO_RPC_URL, ws = env.AVEO_WS_URL
  check(rpc && ws && (env.AVEO_CLUSTER === undefined || env.AVEO_CLUSTER === 'localnet'))
  for (const [raw, protocol] of [[rpc, 'http:'], [ws, 'ws:']]) {
    check(/^(http|ws):\/\/(127\.0\.0\.1|\[::1\])(?::[0-9]+)?\/?$/.test(raw!))
    const url = new URL(raw!)
    check(url.protocol === protocol && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/')
  }
  const genesis = env.AVEO_LOCAL_GENESIS_HASH
  check(genesis)
  requireLocalGenesis(genesis, genesis)
  return { rpc, ws, genesis }
}

/** Bound the complete identity read, including response-body consumption. */
export async function pinGenesis(rpc: string, expected: string, request: typeof fetch = fetch): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const controller = new AbortController()
  try {
    await Promise.race([
      (async () => {
        const response = await request(rpc, { method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getGenesisHash', params: [] }) })
        check(response.ok)
        const body = object(await response.json())
        check(body.jsonrpc === '2.0' && body.id === 1 && !body.error && typeof body.result === 'string')
        requireLocalGenesis(body.result, expected)
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(failure()) }, 10_000)
      }),
    ])
  } catch { throw failure() } finally { clearTimeout(timer) }
}

export interface StageRequest { stage: Stage; directory: string; env: NodeJS.ProcessEnv; receipt?: string }
type SpawnChild = (command: string, args: string[], options: SpawnOptions) => ChildProcess
type Interrupts = Pick<NodeJS.EventEmitter, 'once' | 'removeListener'>

/** Each child gets its own process group, including demo-report's nested runner. */
export function executeStage(request: StageRequest, timeoutMs = MAX_STAGE_MS,
  spawnChild: SpawnChild = spawn, kill: typeof process.kill = process.kill, interrupts: Interrupts = process): Promise<void> {
  check(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_STAGE_MS)
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const stop = () => {
      if (child?.pid) {
        try { kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
      }
    }
    const finish = (passed: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      interrupts.removeListener('SIGINT', interrupt)
      interrupts.removeListener('SIGTERM', interrupt)
      if (!passed) stop()
      if (passed) resolve(); else reject(failure())
    }
    const interrupt = () => finish(false)
    try {
      child = spawnChild(process.execPath, ['--import', 'tsx', `scripts/${scripts[request.stage]}`,
        ...(request.receipt ? [request.receipt] : [])], {
        cwd: appRoot, env: request.env, detached: true, stdio: 'ignore',
      })
      child.once('error', () => finish(false))
      child.once('exit', (code, signal) => finish(code === 0 && signal === null))
      interrupts.once('SIGINT', interrupt)
      interrupts.once('SIGTERM', interrupt)
      timer = setTimeout(() => finish(false), timeoutMs)
    } catch { finish(false) }
  })
}

export interface CycleDependencies {
  fs: Pick<typeof fs, 'chmodSync' | 'realpathSync' | 'lstatSync' | 'writeFileSync'> & {
    mkdtempSync: (prefix: string) => string
    readdirSync: (directory: string) => string[]
    readFileSync: (file: string, encoding: 'utf8') => string
  }
  temporaryRoot: () => string
  pin: typeof pinGenesis
  execute: (request: StageRequest) => Promise<void>
}
const defaults: CycleDependencies = { fs, temporaryRoot: tmpdir, pin: pinGenesis, execute: executeStage }
export interface CycleReport {
  version: 1
  scope: 'localnet-synthetic'
  status: 'RUNNING' | 'PASS' | 'FAIL'
  stages: { id: Stage; status: 'RUNNING' | 'PASS' | 'FAIL' | 'NOT_RUN' }[]
  securityMatrix: 'NOT_RUN' | 'NOT_FULL'
  recoveryFile?: string
  resumeFile?: string
}

export async function runLocalCycle(env: NodeJS.ProcessEnv = process.env,
  deps: CycleDependencies = defaults): Promise<{ directory: string; reportFile: string; report: CycleReport }> {
  // No directory or artifacts exist until the explicit validator identity passes.
  const { rpc, ws, genesis } = cycleEndpoints(env)
  await deps.pin(rpc, genesis)
  const temporary = deps.fs.realpathSync(deps.temporaryRoot())
  const repository = deps.fs.realpathSync(path.resolve(appRoot, '..'))
  check(temporary !== repository && !inside(repository, temporary))
  const directory = deps.fs.mkdtempSync(path.join(temporary, 'aveo-local-cycle-'))
  deps.fs.chmodSync(directory, 0o700)
  check(inside(temporary, deps.fs.realpathSync(directory)) && !inside(repository, deps.fs.realpathSync(directory)))
  const reportFile = path.join(directory, 'local-cycle-report.json')
  const report: CycleReport = { version: 1, scope: 'localnet-synthetic', status: 'RUNNING',
    stages: stages.map((id) => ({ id, status: 'NOT_RUN' })), securityMatrix: 'NOT_RUN' }
  const save = (fresh = false) => deps.fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n',
    { flag: fresh ? 'wx' : 'w', mode: 0o600 })
  const read = (name: string) => {
    const file = path.join(directory, name)
    const stats = deps.fs.lstatSync(file)
    check(stats.isFile() && !stats.isSymbolicLink() && stats.size > 0 && stats.size <= 1_048_576 &&
      path.dirname(deps.fs.realpathSync(file)) === directory)
    return object(JSON.parse(deps.fs.readFileSync(file, 'utf8')))
  }
  const identify = (prefix: string) => {
    const pattern = new RegExp(`^${prefix}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.json$`)
    const names = deps.fs.readdirSync(directory).filter((name) => pattern.test(name))
    check(names.length === 1)
    return names[0]!
  }
  const childEnv = { ...env, AVEO_CLUSTER: 'localnet', AVEO_RPC_URL: rpc, AVEO_WS_URL: ws,
    AVEO_LOCAL_GENESIS_HASH: genesis, AVEO_DEV_DIR: directory }
  let signature: string | undefined
  save(true)
  for (const stage of report.stages) {
    stage.status = 'RUNNING'
    save()
    try {
      await deps.execute({ stage: stage.id, directory, env: childEnv,
        ...(stage.id === 'local:recovery:resume' ? { receipt: path.join(directory, report.recoveryFile!) } : {}) })
      if (stage.id === 'local:recovery') {
        report.recoveryFile = identify('local-recovery')
        const recovery = read(report.recoveryFile)
        check(recovery.version === 1 && recovery.scope === 'localnet-synthetic' && recovery.status === 'PASS' &&
          recovery.signatures === 1 && recovery.submissions === 1 && typeof recovery.signature === 'string' && isSignature(recovery.signature))
        signature = recovery.signature
      } else if (stage.id === 'demo:report') {
        const demo = read('acceptance-report.json')
        check(demo.version === 1 && demo.scope === 'localnet-synthetic' && demo.status === 'PASS' && demo.exitCode === 0 &&
          Array.isArray(demo.issues) && demo.issues.length === 0 && Array.isArray(demo.stages) && demo.stages.length === EXPECTED_DEMO_STAGE_IDS.length)
        const checked = demo.stages.map(object)
        check(checked.every((s, i) => s.status === 'PASS' && s.id === EXPECTED_DEMO_STAGE_IDS[i]))
        check(Array.isArray(demo.matrix) && demo.matrix.length === 17)
        const matrix = demo.matrix.map(object)
        check(matrix.every((m) => ['PASS', 'NOT_RUN'].includes(String(m.status))) &&
          new Set(matrix.map((m) => m.id)).size === 17 && matrix.every((m, i) => m.id === `T${String(i + 1).padStart(2, '0')}`))
        // This runner leaves full T04/T05/T10/T17 unexercised even with 42/42 PASS.
        check(matrix.filter((m) => ['T04', 'T05', 'T10', 'T17'].includes(String(m.id))).every((m) => m.status === 'NOT_RUN'))
        report.securityMatrix = 'NOT_FULL'
      } else if (stage.id === 'local:recovery:resume') {
        report.resumeFile = identify('local-recovery-resumed')
        const resume = read(report.resumeFile)
        check(resume.scope === 'localnet-synthetic' && resume.status === 'PASS' && resume.signature === signature &&
          resume.genesis === genesis && resume.signingCalls === 0 && resume.submissionCalls === 0)
      }
      stage.status = 'PASS'
    } catch {
      report.status = 'FAIL'
      stage.status = 'FAIL'
      save()
      return { directory, reportFile, report }
    }
    save()
  }
  report.status = 'PASS'
  save()
  return { directory, reportFile, report }
}

export async function main() {
  try {
    const result = await runLocalCycle()
    console.log(`${result.report.status} local-cycle: ${result.reportFile}; security matrix ${result.report.securityMatrix}`)
    if (result.report.status !== 'PASS') process.exitCode = 1
  } catch { console.error(failure().message); process.exitCode = 1 }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main()
