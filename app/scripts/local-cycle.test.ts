import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { cycleEndpoints, executeStage, EXPECTED_DEMO_STAGE_IDS, MAX_STAGE_MS, pinGenesis, runLocalCycle, type CycleDependencies, type StageRequest } from './local-cycle'

const genesis = '4nfcdrcw57kgy95FkeDLZ5aVcjMThnMpW1acN1gsmZyF'
const signature = '1'.repeat(64)
const env = { AVEO_RPC_URL: 'http://127.0.0.1:18899', AVEO_WS_URL: 'ws://[::1]:18900', AVEO_LOCAL_GENESIS_HASH: genesis }
const uuid = '00000000-0000-0000-0000-000000000000'
const recoveryName = `local-recovery-${uuid}.json`
const resumedName = `local-recovery-resumed-${uuid}.json`
const directories: string[] = []
function recovery() {
  return { version: 1, scope: 'localnet-synthetic', status: 'PASS', signature, signatures: 1, submissions: 1 }
}
function demo() {
  return { version: 1, scope: 'localnet-synthetic', status: 'PASS', exitCode: 0, issues: [],
    stages: EXPECTED_DEMO_STAGE_IDS.map((id) => ({ id: String(id), status: 'PASS' })),
    matrix: Array.from({ length: 17 }, (_, i) => ({ id: `T${String(i + 1).padStart(2, '0')}`, status: [3, 4, 9, 16].includes(i) ? 'NOT_RUN' : 'PASS' })) }
}
function write(directory: string, name: string, value: unknown) {
  fs.writeFileSync(path.join(directory, name), JSON.stringify(value), { mode: 0o600 })
}
function harness(adapt?: (request: StageRequest) => void): CycleDependencies {
  return { fs: { ...fs,
    mkdtempSync: (prefix) => {
      const directory = fs.mkdtempSync(prefix)
      directories.push(String(directory))
      return directory
    },
    readFileSync: vi.fn((...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]).endsWith('wallets.json')) throw new Error('Wallet bytes must never be read')
      return fs.readFileSync(...args)
    }) as typeof fs.readFileSync,
  }, temporaryRoot: tmpdir, pin: vi.fn(async () => {}), execute: vi.fn(async (request: StageRequest) => {
    if (request.stage === 'fixtures') write(request.directory, 'wallets.json', 'CHILD_SECRET')
    if (request.stage === 'local:recovery') write(request.directory, recoveryName, recovery())
    if (request.stage === 'demo:report') write(request.directory, 'acceptance-report.json', demo())
    if (request.stage === 'local:recovery:resume') write(request.directory, resumedName,
      { scope: 'localnet-synthetic', status: 'PASS', signature, genesis, signingCalls: 0, submissionCalls: 0 })
    adapt?.(request)
  }) }
}
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('bounded synthetic local cycle', () => {
  it('persists a running state rather than a failure while a child stage executes', async () => {
    const deps = harness((request) => {
      const report = JSON.parse(fs.readFileSync(path.join(request.directory, 'local-cycle-report.json'), 'utf8'))
      expect(report.status).toBe('RUNNING')
      expect(report.stages.find((stage: { id: string }) => stage.id === request.stage).status).toBe('RUNNING')
    })
    expect((await runLocalCycle(env, deps)).report.status).toBe('PASS')
  })
  it('pins identity before artifacts, uses fresh private directories and validates persisted evidence', async () => {
    const deps = harness()
    const first = await runLocalCycle(env, deps)
    const second = await runLocalCycle(env, deps)
    expect(first.directory).not.toBe(second.directory)
    expect(fs.statSync(first.directory).mode & 0o777).toBe(0o700)
    expect(fs.statSync(first.reportFile).mode & 0o777).toBe(0o600)
    expect(first.report).toMatchObject({ status: 'PASS', securityMatrix: 'NOT_FULL', recoveryFile: recoveryName, resumeFile: resumedName })
    expect(first.report.stages.map((s) => s.id)).toEqual(['fixtures', 'local:recovery', 'demo:report', 'local:recovery:resume'])
    expect(first.report.stages.every((s) => s.status === 'PASS')).toBe(true)
    const calls = vi.mocked(deps.execute).mock.calls.slice(0, 4)
    expect(calls.every(([r]) => r.env.AVEO_DEV_DIR === first.directory && r.env.AVEO_LOCAL_GENESIS_HASH === genesis)).toBe(true)
    expect(calls[3]![0].receipt).toBe(path.join(first.directory, recoveryName))
    expect(vi.mocked(deps.pin).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(deps.execute).mock.invocationCallOrder[0]!)
    const summary = fs.readFileSync(first.reportFile, 'utf8')
    for (const forbidden of ['CHILD_SECRET', signature, env.AVEO_RPC_URL, env.AVEO_WS_URL, 'secretKey', 'rawTransaction']) expect(summary).not.toContain(forbidden)
  })

  it('foreign genesis stops fixtures and directory creation', async () => {
    const deps = harness()
    deps.pin = (rpc, expected) => pinGenesis(rpc, expected, vi.fn(async () => ({ ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: '11111111111111111111111111111111' }) })) as unknown as typeof fetch)
    deps.fs.mkdtempSync = vi.fn(deps.fs.mkdtempSync)
    await expect(runLocalCycle(env, deps)).rejects.toThrow()
    expect(deps.execute).not.toHaveBeenCalled()
    expect(deps.fs.mkdtempSync).not.toHaveBeenCalled()
  })

  it.each([
    { AVEO_LOCAL_GENESIS_HASH: undefined }, { AVEO_RPC_URL: undefined }, { AVEO_WS_URL: undefined },
    { AVEO_RPC_URL: 'http://localhost:8899' }, { AVEO_RPC_URL: 'http://2130706433:8899' },
    { AVEO_RPC_URL: 'http://127.0.0.1:8899/proxy' }, { AVEO_WS_URL: 'ws://127.0.0.1:8900?secret=1' },
    { AVEO_RPC_URL: 'https://127.0.0.1:8899' }, { AVEO_CLUSTER: 'devnet' },
    { AVEO_LOCAL_GENESIS_HASH: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' },
  ])('requires explicit literal loopback configuration %j', (change) => {
    expect(() => cycleEndpoints({ ...env, ...change })).toThrow()
  })

  it.each(['fixtures', 'local:recovery', 'demo:report', 'local:recovery:resume'])(
    'stops later stages after %s fails and retains a private static failure report', async (failed) => {
      const deps = harness((r) => { if (r.stage === failed) throw new Error('CHILD_SECRET rawTransaction endpoint') })
      const result = await runLocalCycle(env, deps)
      const index = result.report.stages.findIndex((s) => s.id === failed)
      expect(deps.execute).toHaveBeenCalledTimes(index + 1)
      expect(result.report.status).toBe('FAIL')
      expect(result.report.stages[index]!.status).toBe('FAIL')
      expect(result.report.stages.slice(index + 1).every((s) => s.status === 'NOT_RUN')).toBe(true)
      expect(fs.statSync(result.reportFile).mode & 0o777).toBe(0o600)
      expect(fs.existsSync(path.join(result.directory, 'wallets.json'))).toBe(true)
      expect(fs.readFileSync(result.reportFile, 'utf8')).not.toContain('CHILD_SECRET')
    })

  it.each(['status', 'signatures', 'submissions', 'signature', 'scope'])(
    'rejects exit-zero recovery with invalid persisted %s', async (field) => {
      const deps = harness((r) => { if (r.stage === 'local:recovery') write(r.directory, recoveryName, { ...recovery(), [field]: 'invalid' }) })
      const result = await runLocalCycle(env, deps)
      expect(result.report.status).toBe('FAIL')
      expect(deps.execute).toHaveBeenCalledTimes(2)
    })

  it.each(['missing', 'duplicate', 'symlink', 'oversized', 'wrong-prefix'])(
    'rejects %s recovery file without reading wallets', async (kind) => {
      const deps = harness((r) => {
        if (r.stage !== 'local:recovery') return
        const file = path.join(r.directory, recoveryName)
        if (kind === 'duplicate') write(r.directory, recoveryName.replace('00000000-', '11111111-'), recovery())
        if (kind === 'oversized') fs.writeFileSync(file, ' '.repeat(1_048_577))
        if (['missing', 'symlink', 'wrong-prefix'].includes(kind)) fs.unlinkSync(file)
        if (kind === 'symlink') fs.symlinkSync(path.join(r.directory, 'wallets.json'), file)
        if (kind === 'wrong-prefix') write(r.directory, 'local-recovery-wallets.json', recovery())
      })
      expect((await runLocalCycle(env, deps)).report.status).toBe('FAIL')
      expect(deps.execute).toHaveBeenCalledTimes(2)
    })

  it.each(['count', 'stage-fail', 'duplicate', 'arbitrary-ids', 'order', 'matrix-fail', 'matrix-full', 'issues', 'exit'])(
    'rejects false demo PASS: %s', async (kind) => {
      const deps = harness((r) => {
        if (r.stage !== 'demo:report') return
        const report = demo()
        if (kind === 'count') report.stages.pop()
        if (kind === 'stage-fail') report.stages[0]!.status = 'NOT_RUN'
        if (kind === 'duplicate') report.stages[1]!.id = report.stages[0]!.id
        if (kind === 'arbitrary-ids') report.stages.forEach((s, i) => { s.id = `arbitrary-${i}` })
        if (kind === 'order') [report.stages[0], report.stages[1]] = [report.stages[1]!, report.stages[0]!]
        if (kind === 'matrix-fail') report.matrix[0]!.status = 'FAIL'
        if (kind === 'matrix-full') report.matrix.forEach((m) => { m.status = 'PASS' })
        if (kind === 'issues') (report.issues as string[]).push('failure')
        if (kind === 'exit') report.exitCode = 1
        write(r.directory, 'acceptance-report.json', report)
      })
      expect((await runLocalCycle(env, deps)).report.status).toBe('FAIL')
      expect(deps.execute).toHaveBeenCalledTimes(3)
    })

  it('rejects a resumed PASS for another signature', async () => {
    const deps = harness((r) => { if (r.stage === 'local:recovery:resume') write(r.directory, resumedName,
      { scope: 'localnet-synthetic', status: 'PASS', signature: '2'.repeat(88), genesis, signingCalls: 0, submissionCalls: 0 }) })
    expect((await runLocalCycle(env, deps)).report.status).toBe('FAIL')
  })

  it('bounds even an identity transport that ignores abort', async () => {
    vi.useFakeTimers()
    const pending = expect(pinGenesis(env.AVEO_RPC_URL, genesis, vi.fn(() => new Promise<Response>(() => {})))).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(10_000)
    await pending
  })

  it.each(['SIGINT', 'SIGTERM'])('stops only its child process group on %s and removes handlers', async (signal) => {
    const child = Object.assign(new EventEmitter(), { pid: 12345, kill: vi.fn() }) as unknown as ChildProcess
    const interrupts = new EventEmitter()
    const kill = vi.fn(() => true as const)
    const operation = executeStage({ stage: 'fixtures', directory: '/unused', env }, 1000, () => child, kill, interrupts)
    const assertion = expect(operation).rejects.toThrow('Local cycle failed')
    interrupts.emit(signal)
    await assertion
    expect(kill).toHaveBeenCalledExactlyOnceWith(-12345, 'SIGKILL')
    expect(interrupts.listenerCount('SIGINT')).toBe(0)
    expect(interrupts.listenerCount('SIGTERM')).toBe(0)
  })

  it.each(['timeout', 'error', 'nonzero', 'success'])(
    'spawns with discarded output and handles %s without printing child secrets', async (kind) => {
      vi.useFakeTimers()
      const child = Object.assign(new EventEmitter(), { pid: 12345, kill: vi.fn() }) as unknown as ChildProcess
      const spawn = vi.fn(() => child)
      const kill = vi.fn(() => true as const)
      const log = vi.spyOn(console, 'log'), error = vi.spyOn(console, 'error')
      const request: StageRequest = { stage: 'fixtures', directory: '/unused', env }
      const operation = executeStage(request, 20, spawn, kill)
      const assertion = kind === 'success' ? expect(operation).resolves.toBeUndefined() : expect(operation).rejects.toThrow('Local cycle failed')
      if (kind === 'timeout') await vi.advanceTimersByTimeAsync(20)
      if (kind === 'error') child.emit('error', new Error('CHILD_SECRET'))
      if (kind === 'nonzero') child.emit('exit', 1, null)
      if (kind === 'success') child.emit('exit', 0, null)
      await assertion
      expect(spawn).toHaveBeenCalledWith(process.execPath, ['--import', 'tsx', 'scripts/fixtures.ts'],
        expect.objectContaining({ detached: true, stdio: 'ignore', env }))
      if (kind === 'success') expect(kill).not.toHaveBeenCalled()
      else expect(kill).toHaveBeenCalledWith(-12345, 'SIGKILL')
      expect(log).not.toHaveBeenCalled()
      expect(error).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
      expect(() => executeStage(request, MAX_STAGE_MS + 1, spawn, kill)).toThrow()
    })
})
