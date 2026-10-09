// Public, read-only readiness evidence for the synthetic local demonstration.
import { findAssociatedTokenPda, getTokenDecoder } from '@solana-program/token-2022'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { address, type Address } from '@solana/kit'
import { readAccounts, type RawAccount } from '../src/api/accounts'
import { AVEO_HOOK_PROGRAM_ID, SAS_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '../src/api/constants'
import { createApiContext, type ApiContext } from '../src/api/context'
import type { DeskSnapshot } from '../src/api/diagnostics'
import { inspectEligibility } from '../src/api/eligibility'
import { parseDeployment, type Deployment } from '../src/config/deployment'
import { AcceptanceReportBuilder, type PublicEvidence } from './acceptance-report'
import { faultContext, requireLocalFaultEndpoint } from './fault-check'

class HealthExpectation extends Error {}
function requireReady(condition: unknown, message: string): asserts condition {
  if (!condition) throw new HealthExpectation(message)
}
export const HEALTH_STAGES = [
  'health-localnet-preconditions', 'health-programs-executable', 'health-current-eligibility',
  'health-shared-proof', 'health-token-accounts', 'health-no-delegate',
] as const

export function healthSubjects(deployment: Deployment) {
  requireReady(deployment.cluster === 'localnet' && deployment.programs.aveoHook === AVEO_HOOK_PROGRAM_ID &&
    deployment.programs.sas === SAS_PROGRAM_ID && deployment.programs.token2022 === TOKEN_2022_PROGRAM_ID,
  'Health checks require the supported synthetic local deployment')
  requireReady(Number.isFinite(Date.parse(deployment.generatedAt)), 'Fixture generation timestamp is invalid')
  const assets = ['alfa', 'beta'].map((id) => {
    const matches = deployment.assets.filter((asset) => asset.id === id)
    requireReady(matches.length === 1, 'Health checks require exactly one Alfa and one Beta asset')
    return matches[0]!
  })
  const wallets = ['treasury', 'X'].map((id) => {
    const matches = deployment.wallets.filter((wallet) => wallet.id === id)
    requireReady(matches.length === 1, 'Health checks require unambiguous treasury and X wallets')
    return matches[0]!
  })
  requireReady(deployment.assets.length === 2 && assets[0]!.mint !== assets[1]!.mint && wallets[0]!.address !== wallets[1]!.address,
    'Health assets and subjects must be distinct')
  return { assets, wallets }
}

/** Eligibility is an observation, not a prediction that a later transfer will succeed. */
export function requireHealthySnapshot(ctx: ApiContext, snapshot: DeskSnapshot, mint: Address, wallet: Address, floor: number): void {
  requireReady(snapshot.mint === mint && snapshot.wallet === wallet && snapshot.backend === 'aveo-sas-hook' &&
    snapshot.read.cluster === ctx.cluster && snapshot.read.rpcUrl === ctx.rpcUrl && snapshot.read.commitment === ctx.commitment,
    'Eligibility observation belongs to another subject or context')
  requireReady(snapshot.verdict === 'eligible' && Number.isSafeInteger(snapshot.read.slot) && snapshot.read.slot >= floor,
    'Eligibility is blocked, unknown or older than the readiness observation')
  requireReady(snapshot.proof && snapshot.sourceAccounts.attestation === snapshot.proof.attestation &&
    snapshot.clockUnix !== undefined && Number.isSafeInteger(snapshot.clockUnix) && snapshot.clockUnix >= 0 &&
    snapshot.proof.expiry - BigInt(snapshot.clockUnix) >= 120n,
    'A bound proof needs at least two minutes of validity against the validator Clock')
}

export function decodeHealthyToken(account: RawAccount | null, mint: Address, owner: Address) {
  requireReady(account && account.owner === TOKEN_2022_PROGRAM_ID && !account.executable, 'A required Token-2022 account is missing or invalid')
  const token = getTokenDecoder().decode(account.data)
  requireReady(token.mint === mint && token.owner === owner && token.state === 1 && token.amount > 0n,
    'A required token account has the wrong owner, mint, state or insufficient demo balance')
  return token
}

export async function checkDemoHealth(ctx: ApiContext, emit: (record: PublicEvidence) => void, complete: (stage: typeof HEALTH_STAGES[number]) => void): Promise<void> {
  requireLocalFaultEndpoint(ctx.rpcUrl)
  requireReady(ctx.commitment === 'confirmed' || ctx.commitment === 'finalized', 'Health requires confirmed or finalized reads')
  requireReady(ctx.programId === AVEO_HOOK_PROGRAM_ID, 'Unsupported readiness program')
  const { assets, wallets } = healthSubjects(ctx.deployment)
  complete(HEALTH_STAGES[0])
  const programs = await readAccounts(ctx, [ctx.programId, SAS_PROGRAM_ID, TOKEN_2022_PROGRAM_ID])
  requireReady(programs.slot > 0 && programs.accounts.every((program) => program?.executable), 'Required programs must be executable on the local validator')
  emit({ slot: programs.slot })
  complete(HEALTH_STAGES[1])
  const observed = await Promise.all(wallets.map(async (wallet) => ({ wallet,
    snapshots: await Promise.all(assets.map((asset) => inspectEligibility(ctx, asset.mint, wallet.address))),
  })))
  for (const { wallet, snapshots } of observed) {
    emit({ wallet: wallet.address, mints: assets.map((asset) => asset.mint), verdicts: snapshots.map((snapshot) => snapshot.verdict), slots: snapshots.map((snapshot) => snapshot.read.slot) })
    snapshots.forEach((snapshot, index) => requireHealthySnapshot(ctx, snapshot, assets[index]!.mint, wallet.address, programs.slot))
  }
  complete(HEALTH_STAGES[2])
  for (const { wallet, snapshots } of observed) {
    const shared = snapshots[0]!.sourceAccounts.attestation
    requireReady(shared && snapshots.every((snapshot) => snapshot.sourceAccounts.attestation === shared), 'Each readiness subject must reuse one proof across both assets')
    emit({ wallet: wallet.address, sharedProof: address(shared), mints: assets.map((asset) => asset.mint) })
  }
  complete(HEALTH_STAGES[3])
  const floor = Math.max(programs.slot, ...observed.flatMap((item) => item.snapshots.map((snapshot) => snapshot.read.slot)))
  const pairs = assets.flatMap((asset) => wallets.map((wallet) => ({ asset, wallet })))
  const addresses = await Promise.all(pairs.map(async ({ asset, wallet }) => (await findAssociatedTokenPda({ owner: wallet.address, mint: asset.mint, tokenProgram: TOKEN_2022_PROGRAM_ID }))[0]))
  const read = await readAccounts(ctx, addresses, floor)
  const tokens = read.accounts.map((account, index) => decodeHealthyToken(account, pairs[index]!.asset.mint, pairs[index]!.wallet.address))
  for (let index = 0; index < tokens.length; index += 2) {
    emit({ asset: assets[index / 2]!.id as PublicEvidence['asset'], slot: read.slot, before: [tokens[index]!.amount.toString(), tokens[index + 1]!.amount.toString()] })
  }
  complete(HEALTH_STAGES[4])
  requireReady(tokens.every((token) => token.delegate.__option === 'None' && token.delegatedAmount === 0n), 'Temporary delegate approvals remain on demo token accounts')
  emit({ slot: read.slot, delegatedAllowanceAfter: '0' })
  complete(HEALTH_STAGES[5])
}

async function main(): Promise<void> {
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const reportPath = path.join(appRoot, '.dev', 'health-report.json')
  const report = new AcceptanceReportBuilder(new Date().toISOString())
  let current = 0
  let exitCode = 0
  const line = (value: string) => { report.acceptLine(value); console.log(value) }
  line(`ACCEPTANCE_RUN ${JSON.stringify({ stages: HEALTH_STAGES })}`)
  try {
    const endpoint = process.env.AVEO_RPC_URL ?? 'http://127.0.0.1:8899'
    requireLocalFaultEndpoint(endpoint)
    const deployment = parseDeployment(JSON.parse(readFileSync(path.join(appRoot, '.dev', 'deployment.json'), 'utf8')))
    const base = createApiContext({ cluster: 'localnet', rpcUrl: endpoint, commitment: 'confirmed', programId: deployment.programs.aveoHook, deployment })
    const readonly = faultContext(base, 'none')
    await checkDemoHealth(readonly.ctx, (value) => line(`EVIDENCE ${JSON.stringify(value)}`), (stage) => {
      requireReady(HEALTH_STAGES[current] === stage && readonly.counters.sends === 0, 'Health stage order or read-only guard failed')
      line(`PASS ${stage}`); current++
    })
  } catch (error) {
    exitCode = 1
    line(`FAIL ${HEALTH_STAGES[current]}: ${error instanceof HealthExpectation ? error.message : 'Readiness could not be verified; check the local validator and fixtures'}`)
    for (const stage of HEALTH_STAGES.slice(current + 1)) line(`NOT_RUN ${stage}`)
  }
  const result = report.finish(exitCode, new Date().toISOString())
  mkdirSync(path.dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
  console.log(`${result.status} demo-health (${current}/${HEALTH_STAGES.length}): ${reportPath}`)
  process.exitCode = result.status === 'PASS' ? 0 : 1
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('FAIL demo-health: could not finish the readiness report'); process.exitCode = 1 })
}
