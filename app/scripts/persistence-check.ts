// The acceptance runner supplies actual closed-proof observations. This module never reads RPC or keys.
import { fork } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { serialize } from 'node:v8'
import { openIncidentDatabase } from '@aveo/backend-aveo/sqlite'
import { address } from '@solana/kit'
import type { DeskSnapshot } from '../src/api/diagnostics'
import { applyScan, type IncidentStoreData } from '../src/features/incidents/model'
import type { PublicEvidence } from './acceptance-report'

export const PERSISTENCE_STAGES = [
  'persistence-initial-save', 'persistence-process-restart', 'persistence-repeated-scan',
] as const

const script = fileURLToPath(import.meta.url)
const appRoot = path.resolve(path.dirname(script), '..')
const scope = 'localnet-synthetic-persistence-check'
const maxBytes = 2 * 1024 * 1024
const failure = 'Local incident persistence check failed'

interface Payload {
  scan: IncidentStoreData
  snapshots: DeskSnapshot[]
}
interface WorkerInput {
  file: string
  operation: 'save' | 'reload-repeat'
  payload: Payload
}
interface WorkerResult {
  pid: number
  loaded: Payload
  repeated?: Payload
}

function requireCheck(condition: unknown): asserts condition {
  if (!condition) throw new Error(failure)
}

function requirePayload(payload: Payload): void {
  requireCheck(serialize(payload).byteLength <= maxBytes)
  const { scan, snapshots } = payload
  const slot = scan.lastScan?.slot
  requireCheck(scan.version === 1 && slot !== undefined && Number.isSafeInteger(slot) && slot > 0)
  requireCheck(scan.incidents.length > 0 && scan.incidents.length <= 100 && snapshots.length > 0 && snapshots.length <= 32)
  requireCheck(new Set(scan.incidents.map((incident) => incident.id)).size === scan.incidents.length)
  requireCheck(new Set(snapshots.map((snapshot) => `${snapshot.mint}:${snapshot.wallet}`)).size === snapshots.length)
  requireCheck(snapshots.every((snapshot) => snapshot.backend === 'aveo-sas-hook' && snapshot.read.cluster === 'localnet'
    && snapshot.verdict !== 'unknown' && Number.isSafeInteger(snapshot.read.slot) && snapshot.read.slot > 0
    && snapshot.read.slot <= slot))
  // These are the original observations of the caller's just-applied scan, not a new chain read.
  requireCheck(Math.max(...snapshots.map((snapshot) => snapshot.read.slot)) === slot)
  const blocked = scan.incidents.filter((incident) => incident.state !== 'resolved' && incident.observed)
  requireCheck(blocked.length > 0 && blocked.some((incident) => incident.type === 'PROOF_CLOSED'))
  requireCheck(blocked.every((incident) => incident.affectedMints.length > 0 && incident.affectedMints.every((mint) =>
    snapshots.some((snapshot) => snapshot.mint === mint && snapshot.wallet === incident.wallet
      && snapshot.verdict === 'ineligible' && snapshot.sourceAccounts.attestation === incident.proof))))
}

function repeat(payload: Payload): Payload {
  requirePayload(payload)
  const scan = applyScan(payload.scan, payload.snapshots, payload.scan.lastScan!.slot, payload.scan.lastScan!.at)
  // Exact comparison includes IDs, keys, grouped mints, watched, events, evidence, state and bigint values.
  requireCheck(isDeepStrictEqual(scan, payload.scan))
  return { ...payload, scan }
}

function requireWorkerFile(file: string): void {
  const directory = path.dirname(file)
  requireCheck(path.isAbsolute(file) && path.dirname(directory) === tmpdir()
    && /^aveo-persistence-[a-zA-Z0-9]+$/.test(path.basename(directory)) && path.basename(file) === 'check.sqlite')
}

async function worker(input: WorkerInput): Promise<WorkerResult> {
  requireWorkerFile(input.file)
  requirePayload(input.payload)
  return new Promise((resolve, reject) => {
    // Do not inherit debugger flags, loader arguments, NODE_OPTIONS, or caller-supplied executable arguments.
    const env = { ...process.env }
    delete env.NODE_OPTIONS
    const child = fork(script, ['--persistence-worker'], {
      execPath: process.execPath, execArgv: ['--import', 'tsx'], cwd: appRoot, env,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced',
    })
    let result: WorkerResult | undefined
    let settled = false
    let failed = false
    const fail = () => {
      if (settled) return
      failed = true
      clearTimeout(timer)
      // Wait for close before rejecting: cleanup must not race a still-running writer.
      child.kill('SIGKILL')
    }
    const timer = setTimeout(fail, 15_000)
    child.on('message', (message: WorkerResult) => {
      try {
        requireCheck(result === undefined && serialize(message).byteLength <= 3 * maxBytes
          && message.pid === child.pid && message.pid !== process.pid)
        result = message
      } catch { fail() }
    })
    child.on('error', fail)
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (failed || code !== 0 || result === undefined) reject(new Error(failure))
      else resolve(result)
    })
    child.send(input, (error) => { if (error) fail() })
  })
}

function workerMain(): void {
  process.once('message', (input: WorkerInput) => {
    let database: ReturnType<typeof openIncidentDatabase> | undefined
    try {
      requireWorkerFile(input.file)
      requirePayload(input.payload)
      database = openIncidentDatabase(input.file)
      if (input.operation === 'save') database.save(scope, input.payload)
      else requireCheck(input.operation === 'reload-repeat')
      const loaded = database.load<Payload>(scope)
      requireCheck(loaded !== undefined && isDeepStrictEqual(loaded, input.payload))
      let repeated: Payload | undefined
      if (input.operation === 'reload-repeat') {
        repeated = repeat(loaded)
        database.save(scope, repeated)
        requireCheck(isDeepStrictEqual(database.load<Payload>(scope), repeated))
      }
      database.close()
      database = undefined
      process.send?.({ pid: process.pid, loaded, repeated }, (error) => {
        if (error) process.exitCode = 1
        process.disconnect()
      })
    } catch {
      process.exitCode = 1
      process.disconnect()
    } finally { database?.close() }
  })
}

export async function checkIncidentPersistence(
  scan: IncidentStoreData,
  snapshots: DeskSnapshot[],
  emit: (record: PublicEvidence) => void,
  complete: (stage: typeof PERSISTENCE_STAGES[number]) => void,
): Promise<void> {
  let directory: string | undefined
  try {
    const payload = { scan, snapshots }
    requirePayload(payload)
    // Validate the replay before creating files or emitting any successful stage.
    repeat(payload)
    directory = mkdtempSync(path.join(tmpdir(), 'aveo-persistence-'))
    const file = path.join(directory, 'check.sqlite')
    const saved = await worker({ file, operation: 'save', payload })
    requireCheck(isDeepStrictEqual(saved.loaded, payload))
    emit({ slots: snapshots.map((snapshot) => snapshot.read.slot), sendCalls: 0 })
    complete(PERSISTENCE_STAGES[0])

    // The first process has exited and closed SQLite before this process starts.
    const restarted = await worker({ file, operation: 'reload-repeat', payload })
    requireCheck(restarted.pid !== saved.pid && isDeepStrictEqual(restarted.loaded, payload))
    emit({ slot: scan.lastScan!.slot, sendCalls: 0 })
    complete(PERSISTENCE_STAGES[1])

    requireCheck(isDeepStrictEqual(restarted.repeated, payload))
    for (const incident of scan.incidents.filter((item) => item.state !== 'resolved' && item.observed)) {
      emit({ wallet: address(incident.wallet), proof: address(incident.proof),
        affectedMints: incident.affectedMints.map((mint) => address(mint)), incidentType: incident.type })
    }
    complete(PERSISTENCE_STAGES[2])
  } catch { throw new Error(failure) }
  finally { if (directory) rmSync(directory, { recursive: true, force: true }) }
}

// This is an internal IPC worker, not a public CLI or an RPC entry point.
if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  if (process.argv.length === 3 && process.argv[2] === '--persistence-worker' && process.send) workerMain()
  else { console.error(failure); process.exitCode = 1 }
}
