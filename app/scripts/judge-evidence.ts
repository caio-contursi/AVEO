// Export only public observations from a complete, guarded synthetic local run.
import { closeSync, constants, fstatSync, openSync, readSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSolanaRpc } from '@solana/kit'
import { parseDeployment, type Deployment } from '../src/config/deployment'
import { DEMO_SCENES, parseDemoEvidence } from '../src/features/demo/evidence'
import { DEMO_ACCEPTANCE_MANIFEST } from './acceptance-stages'
import { localArtifactDirectory, requireLocalEndpoints, requireLocalGenesis } from './localnet-safety'
import { assertNoManifestSecrets } from './public-manifest'

const fail = () => new Error('Judge evidence requires a complete local acceptance report and its matching deployment.')
function check(value: unknown): asserts value { if (!value) throw fail() }
function object(value: unknown): Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}

// Projection deliberately excludes arbitrary report fields, credentials and process logs.
const PUBLIC_FIELDS = [
  'signature', 'slot', 'status', 'hookCode', 'wallet', 'source', 'destination',
  'sharedProof', 'closedProof', 'proof', 'renewal', 'mints', 'affectedMints', 'slots',
  'asset', 'accepted', 'before', 'after', 'incidentType', 'verdicts', 'expiry', 'clockUnix',
] as const

export function buildJudgeEvidence(raw: unknown, deployment: Deployment, genesisHash: string) {
  requireLocalGenesis(genesisHash, genesisHash)
  check(deployment.cluster === 'localnet')
  const report = object(raw)
  check(report.version === 1 && report.scope === 'localnet-synthetic' && report.status === 'PASS'
    && report.exitCode === 0 && Array.isArray(report.issues) && report.issues.length === 0
    && typeof report.finishedAt === 'string' && Array.isArray(report.stages))
  const stages = report.stages.map(object)
  check(stages.length === DEMO_ACCEPTANCE_MANIFEST.stageIds.length)
  stages.forEach((stage, index) => {
    check(stage.id === DEMO_ACCEPTANCE_MANIFEST.stageIds[index] && stage.status === 'PASS'
      && Array.isArray(stage.evidence))
  })
  const provenance = (stages[0]!.evidence as unknown[]).map(object)
  check(provenance.length === 1 && provenance[0]!.genesisHash === genesisHash
    && provenance[0]!.deploymentGeneratedAt === deployment.generatedAt)
  const scenes = DEMO_SCENES.map((scene) => ({
    id: scene.id,
    stages: scene.stageIds.map((id) => {
      const stage = stages.find((candidate) => candidate.id === id)
      check(stage && Array.isArray(stage.evidence) && stage.evidence.length > 0)
      return { id, status: 'PASS', evidence: stage.evidence.map((rawEvidence) => {
        const evidence = object(rawEvidence)
        return Object.fromEntries(PUBLIC_FIELDS.filter((key) => evidence[key] !== undefined)
          .map((key) => [key, evidence[key]]))
      }) }
    }),
  }))
  return parseDemoEvidence({
    version: 1, scope: 'localnet-synthetic', genesisHash, programId: deployment.programs.aveoHook,
    deploymentGeneratedAt: deployment.generatedAt, completedAt: report.finishedAt,
    assets: deployment.assets.map(({ id, mint }) => ({ id, mint })),
    wallets: deployment.wallets.map(({ id, address }) => ({ id, address })), scenes,
  }, deployment)
}

/** Fixed-name public files only; refuse links and oversized/untrusted artifacts. */
export function readJudgePublicJson(directory: string, name: 'deployment.json' | 'acceptance-report.json' | 'judge-evidence.json') {
  check(['deployment.json', 'acceptance-report.json', 'judge-evidence.json'].includes(name))
  const file = path.join(directory, name)
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stats = fstatSync(descriptor)
    check(stats.isFile() && stats.size > 0 && stats.size <= 2_000_000)
    const bytes = Buffer.alloc(2_000_001)
    let length = 0
    for (;;) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, length)
      if (count === 0) break
      length += count
      check(length <= 2_000_000)
    }
    check(length > 0)
    return JSON.parse(bytes.subarray(0, length).toString('utf8')) as unknown
  } finally { closeSync(descriptor) }
}

/** The dev server revalidates before returning bytes; a renamed wallet file cannot leak. */
export function readJudgeEvidenceResponse(directory: string): string {
  const deployment = parseDeployment(readJudgePublicJson(directory, 'deployment.json'))
  const evidence = parseDemoEvidence(readJudgePublicJson(directory, 'judge-evidence.json'), deployment)
  return JSON.stringify(evidence)
}

export function readDevDeploymentResponse(directory: string): string {
  const raw = readJudgePublicJson(directory, 'deployment.json')
  assertNoManifestSecrets(raw)
  return JSON.stringify(parseDeployment(raw))
}

export async function main(env: NodeJS.ProcessEnv = process.env) {
  const rpc = env.AVEO_RPC_URL, ws = env.AVEO_WS_URL, genesis = env.AVEO_LOCAL_GENESIS_HASH
  check(rpc && ws && genesis && env.AVEO_DEV_DIR && (env.AVEO_CLUSTER === undefined || env.AVEO_CLUSTER === 'localnet'))
  requireLocalEndpoints(rpc, ws)
  requireLocalGenesis(genesis, genesis)
  const directory = localArtifactDirectory(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), env.AVEO_DEV_DIR)
  const actual = await createSolanaRpc(rpc).getGenesisHash().send({ abortSignal: AbortSignal.timeout(10_000) })
  requireLocalGenesis(actual, genesis)
  const deployment = parseDeployment(readJudgePublicJson(directory, 'deployment.json'))
  const evidence = buildJudgeEvidence(readJudgePublicJson(directory, 'acceptance-report.json'), deployment, actual)
  const destination = path.join(directory, 'judge-evidence.json')
  // Never replace an existing artifact, even if it is a symlink or belongs to a prior run.
  writeFileSync(destination, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  console.log(`PASS demo:evidence: ${destination}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('FAIL demo:evidence: public evidence was not exported; check the local run and destination.'); process.exitCode = 1 })
}
