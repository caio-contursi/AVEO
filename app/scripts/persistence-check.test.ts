import { fork, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { getAddressDecoder } from '@solana/kit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeskSnapshot } from '../src/api/diagnostics'
import { applyScan, EMPTY_STORE, type IncidentStoreData } from '../src/features/incidents/model'
import { AcceptanceReportBuilder, type PublicEvidence } from './acceptance-report'
import { checkIncidentPersistence, PERSISTENCE_STAGES } from './persistence-check'

// Wrap, never replace, real subprocesses. IPC remains Node's advanced serialization.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, fork: vi.fn((...args: Parameters<typeof actual.fork>) => {
    const child = actual.fork(...args)
    vi.spyOn(child, 'send')
    return child
  }) }
})

const NOW = '2026-10-09T12:00:00.000Z'
const FAILURE = 'Local incident persistence check failed'
const address = (byte: number) => getAddressDecoder().decode(new Uint8Array(32).fill(byte))
const wallet = address(1)
const proof = address(2)
const mints = [address(3), address(4)]

function fixture(): { scan: IncidentStoreData; snapshots: DeskSnapshot[] } {
  // Typed RPC snapshot fixtures model an eligible watch followed by an actual closed-proof observation.
  // These are unit inputs, never evidence that a local validator was exercised.
  const eligible: DeskSnapshot[] = mints.map((mint, index) => ({
    backend: 'aveo-sas-hook', wallet, mint, verdict: 'eligible', reasons: [], actions: [],
    policyVersion: 18446744073709551615n,
    read: { cluster: 'localnet', rpcUrl: 'http://127.0.0.1:8899', commitment: 'confirmed', slot: 40, observedAt: NOW },
    sourceAccounts: { policy: address(5 + index), binding: address(7 + index), attestation: proof },
    proof: { attestation: proof, credential: address(9), schema: address(10), signer: address(11),
      expiry: 9007199254740993n, kycPass: true, accreditedPass: true },
  }))
  const watched = applyScan(EMPTY_STORE, eligible, 40, NOW)
  const snapshots: DeskSnapshot[] = eligible.map((snapshot, index) => {
    const closed = { ...snapshot }
    delete closed.proof
    return { ...closed, verdict: 'ineligible', read: { ...snapshot.read, slot: 42 + index },
      reasons: [{ code: 'AttestationMissingOrClosed', message: 'Synthetic unit closed-proof observation' }] }
  })
  const scan = applyScan(watched, snapshots, 43, NOW)
  // Exercise bigint deserialization inside incident state as well as the retained observations.
  scan.incidents[0]!.evidence = [{ status: 'confirmed', slot: 40, logs: ['private diagnostic marker'], readback: eligible }]
  return { scan, snapshots }
}

function children(): ChildProcess[] {
  return vi.mocked(fork).mock.results.filter((result) => result.type === 'return').map((result) => result.value as ChildProcess)
}

function databaseFile(child: ChildProcess): string {
  const input = vi.mocked(child.send).mock.calls[0]?.[0] as { file: string }
  return input.file
}

afterEach(() => { vi.clearAllMocks() })

describe('real-process SQLite persistence acceptance', () => {
  it('saves, exits, restarts and repeats a grouped two-mint store with exact bigint state and immutable caller inputs', async () => {
    expect(Number(process.versions.node.split('.')[0])).toBeGreaterThanOrEqual(22)
    const { scan, snapshots } = fixture()
    const original = structuredClone({ scan, snapshots })
    const emitted: PublicEvidence[] = []
    const completed: string[] = []
    const report = new AcceptanceReportBuilder(NOW)
    report.acceptLine(`ACCEPTANCE_RUN ${JSON.stringify({ stages: PERSISTENCE_STAGES })}`)
    await checkIncidentPersistence(scan, snapshots, (record) => {
      emitted.push(record)
      report.acceptLine(`EVIDENCE ${JSON.stringify(record)}`)
      const child = children()[0]!
      // Before cleanup the file is a real SQLite database, not an in-memory stand-in.
      expect(readFileSync(databaseFile(child)).subarray(0, 16).toString()).toBe('SQLite format 3\u0000')
    }, (stage) => {
      completed.push(stage)
      report.acceptLine(`PASS ${stage}`)
      if (stage === PERSISTENCE_STAGES[0]) expect(children()[0]?.exitCode).toBe(0)
    })
    expect(completed).toEqual([...PERSISTENCE_STAGES])
    expect(children()).toHaveLength(2)
    const [saved, restarted] = children()
    expect(saved!.pid).not.toBe(restarted!.pid)
    expect(saved!.pid).not.toBe(process.pid)
    expect(restarted!.pid).not.toBe(process.pid)
    expect(children().every((child) => child.exitCode === 0 && !child.connected)).toBe(true)
    expect(vi.mocked(fork).mock.calls.every((call) => call[2]?.serialization === 'advanced'
      && JSON.stringify(call[1]) === JSON.stringify(['--persistence-worker'])
      && JSON.stringify(call[2]?.execArgv) === JSON.stringify(['--import', 'tsx']))).toBe(true)
    expect({ scan, snapshots }).toEqual(original)
    expect(scan.incidents).toHaveLength(1)
    expect(scan.incidents[0]).toMatchObject({ type: 'PROOF_CLOSED', state: 'open', affectedMints: mints, observed: true })
    expect(scan.incidents[0]!.evidence[0]!.readback![0]!.policyVersion).toBe(18446744073709551615n)
    expect(snapshots[0]!.policyVersion).toBe(18446744073709551615n)
    expect(scan.watched).toEqual({ [`${mints[0]}:${wallet}`]: proof, [`${mints[1]}:${wallet}`]: proof })
    expect(existsSync(path.dirname(databaseFile(saved!)))).toBe(false)
    const result = report.finish(0, NOW)
    expect(result.status).toBe('PASS')
    expect(result.stages.flatMap((stage) => stage.evidence)).toEqual(emitted)
    expect(result.matrix.filter((entry) => entry.status === 'PASS').map((entry) => entry.id)).toEqual(['T15'])
    expect(JSON.stringify(result)).not.toContain('private diagnostic marker')
    expect(JSON.stringify(result)).not.toContain('rpcUrl')
    expect(JSON.stringify(result)).not.toContain('watched')
    expect(emitted).toEqual([
      { slots: [42, 43], sendCalls: 0 },
      { slot: 43, sendCalls: 0 },
      { wallet, proof, affectedMints: mints, incidentType: 'PROOF_CLOSED' },
    ])
  }, 15_000)

  it('retains existing lifecycle events and resolved history without resolving the open incident', async () => {
    const { scan, snapshots } = fixture()
    const current = scan.incidents[0]!
    current.state = 'awaiting-confirmation'
    current.events.push({ at: NOW, kind: 'unknown' })
    scan.incidents.push({ ...structuredClone(current), id: 'previous-resolved-incident', key: 'previous-key',
      state: 'resolved', observed: false, resolvedSlot: 41 })
    const original = structuredClone(scan)
    const complete = vi.fn()
    await checkIncidentPersistence(scan, snapshots, vi.fn(), complete)
    expect(complete.mock.calls.map(([stage]) => stage)).toEqual([...PERSISTENCE_STAGES])
    expect(scan).toEqual(original)
    expect(scan.incidents[0]!.state).toBe('awaiting-confirmation')
  }, 15_000)

  const invalid: [string, (scan: IncidentStoreData, snapshots: DeskSnapshot[]) => void][] = [
    ['empty incidents', (scan) => { scan.incidents = [] }],
    ['empty observations', (_scan, snapshots) => { snapshots.length = 0 }],
    ['unknown observation', (_scan, snapshots) => { snapshots[0]!.verdict = 'unknown' }],
    ['partial grouped read', (_scan, snapshots) => { snapshots.splice(0, 1) }],
    ['eligible read cannot erase blocking lifecycle', (_scan, snapshots) => { snapshots[0]!.verdict = 'eligible' }],
    ['wrong wallet', (_scan, snapshots) => { snapshots[0]!.wallet = address(12) }],
    ['wrong proof', (_scan, snapshots) => { snapshots[0]!.sourceAccounts.attestation = address(12) }],
    ['wrong mint', (_scan, snapshots) => { snapshots[0]!.mint = address(12) }],
    ['duplicate observation', (_scan, snapshots) => { snapshots.push(structuredClone(snapshots[0]!)) }],
    ['duplicate incident identity', (scan) => { scan.incidents.push(structuredClone(scan.incidents[0]!)) }],
    ['unobserved replay creates changed state', (scan) => { scan.incidents[0]!.observed = false }],
    ['mismatched incident key duplicates on replay', (scan) => { scan.incidents[0]!.key = 'mismatched-key' }],
    ['missing last scan', (scan) => { delete scan.lastScan }],
    ['stale observation basis', (_scan, snapshots) => { snapshots[1]!.read.slot = 42 }],
    ['future observation', (_scan, snapshots) => { snapshots[1]!.read.slot = 44 }],
    ['invalid observation slot', (_scan, snapshots) => { snapshots[0]!.read.slot = NaN }],
    ['external cluster', (_scan, snapshots) => { snapshots[0]!.read.cluster = 'devnet' }],
    ['unbounded payload', (_scan, snapshots) => { snapshots[0]!.reasons[0]!.message = 'private'.repeat(400_000) }],
  ]

  it.each(invalid)('rejects %s with a static error and no successful stages', async (_name, mutate) => {
    const { scan, snapshots } = fixture()
    mutate(scan, snapshots)
    const original = structuredClone({ scan, snapshots })
    const emit = vi.fn()
    const complete = vi.fn()
    await expect(checkIncidentPersistence(scan, snapshots, emit, complete)).rejects.toThrow(new Error(FAILURE))
    expect(emit).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
    expect(fork).not.toHaveBeenCalled()
    expect({ scan, snapshots }).toEqual(original)
  })

  it('fails a real restarted child when its database is missing and leaves later stages NOT_RUN', async () => {
    const { scan, snapshots } = fixture()
    const report = new AcceptanceReportBuilder(NOW)
    report.acceptLine(`ACCEPTANCE_RUN ${JSON.stringify({ stages: PERSISTENCE_STAGES })}`)
    const complete = vi.fn((stage: typeof PERSISTENCE_STAGES[number]) => {
      report.acceptLine(`PASS ${stage}`)
      if (stage === PERSISTENCE_STAGES[0]) unlinkSync(databaseFile(children()[0]!))
    })
    await expect(checkIncidentPersistence(scan, snapshots, (record) => {
      report.acceptLine(`EVIDENCE ${JSON.stringify(record)}`)
    }, complete)).rejects.toThrow(new Error(FAILURE))
    expect(complete.mock.calls.map(([stage]) => stage)).toEqual([PERSISTENCE_STAGES[0]])
    expect(children()).toHaveLength(2)
    expect(children()[1]!.exitCode).toBe(1)
    expect(children()[1]!.connected).toBe(false)
    expect(existsSync(path.dirname(databaseFile(children()[0]!)))).toBe(false)
    report.acceptLine(`FAIL ${PERSISTENCE_STAGES[1]}`)
    report.acceptLine(`NOT_RUN ${PERSISTENCE_STAGES[2]}`)
    const result = report.finish(1, NOW)
    expect(result.status).toBe('FAIL')
    expect(result.matrix.find((entry) => entry.id === 'T15')?.status).toBe('FAIL')
    expect(result.stages.map((stage) => stage.status)).toEqual(['PASS', 'FAIL', 'NOT_RUN'])
  }, 15_000)

  it('does not claim PASS or leak callback errors when public evidence cannot be recorded', async () => {
    const { scan, snapshots } = fixture()
    const complete = vi.fn()
    await expect(checkIncidentPersistence(scan, snapshots, () => {
      throw new Error('private diagnostic marker http://secret.invalid')
    }, complete)).rejects.toThrow(new Error(FAILURE))
    expect(complete).not.toHaveBeenCalled()
    expect(children()).toHaveLength(1)
    expect(children()[0]!.exitCode).toBe(0)
    expect(existsSync(path.dirname(databaseFile(children()[0]!)))).toBe(false)
  }, 15_000)

  it('fails closed when SQLite JSON cannot preserve an explicit undefined property exactly', async () => {
    const { scan, snapshots } = fixture()
    snapshots[0]!.proof = undefined
    const original = structuredClone({ scan, snapshots })
    const emit = vi.fn()
    const complete = vi.fn()
    await expect(checkIncidentPersistence(scan, snapshots, emit, complete)).rejects.toThrow(new Error(FAILURE))
    expect(emit).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
    expect(children()).toHaveLength(1)
    expect(children()[0]!.exitCode).toBe(1)
    expect(existsSync(path.dirname(databaseFile(children()[0]!)))).toBe(false)
    expect({ scan, snapshots }).toEqual(original)
  }, 15_000)
})
