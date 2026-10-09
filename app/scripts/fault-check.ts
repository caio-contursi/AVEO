// Read-only local acceptance: healthy RPC reads are real; failures are injected at the SDK boundary.
import { DeskError } from '@aveo/contracts'
import { isSignature, type Address } from '@solana/kit'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AveoSasHookBackend } from '../src/api/backend'
import { readAccounts } from '../src/api/accounts'
import { AVEO_HOOK_PROGRAM_ID } from '../src/api/constants'
import { createApiContext, type ApiContext } from '../src/api/context'
import { inspectEligibility } from '../src/api/eligibility'
import { findPolicyPda } from '../src/api/pdas'
import { confirmSignature } from '../src/api/transactions'
import { parseDeployment } from '../src/config/deployment'
import { EMPTY_STORE, applyScan, applySends, applyVerification } from '../src/features/incidents/model'
import { recheckSubmission } from '../src/features/operations/execution'
import { AcceptanceReportBuilder } from './acceptance-report'

class FaultExpectation extends Error {}
function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new FaultExpectation(message)
}

export function requireLocalFaultEndpoint(endpoint: string): void {
  let url: URL
  try { url = new URL(endpoint) } catch { throw new FaultExpectation('Invalid local RPC endpoint') }
  expect(['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname), 'Fault checks require an explicit loopback RPC')
  expect(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'Fault RPC must not contain credentials, query or a proxy path')
}

export type RpcFault = 'none' | 'unavailable' | 'stale-slot' | 'account-timeout' | 'confirmation-timeout'

/** Fault injection never forwards sendTransaction, even if a tested path mistakenly asks to send. */
export function faultContext(base: ApiContext, mode: RpcFault) {
  const counters = { reads: 0, sends: 0, aborted: 0 }
  const suspend = (options?: { abortSignal?: AbortSignal }): Promise<never> => new Promise((_resolve, reject) => {
    const abort = () => { counters.aborted++; reject(new Error('Injected request cancellation')) }
    if (options?.abortSignal?.aborted) abort()
    else options?.abortSignal?.addEventListener('abort', abort, { once: true })
  })
  const rpc = new Proxy(base.rpc, {
    get(target, key) {
      if (key === 'sendTransaction') return () => { counters.sends++; throw new Error('Fault acceptance is read-only') }
      if (key === 'getSignatureStatuses' && mode === 'confirmation-timeout') {
        return () => ({ send: (options?: { abortSignal?: AbortSignal }) => { counters.reads++; return suspend(options) } })
      }
      if (key === 'getMultipleAccounts') {
        return (addresses: Address[], options: Parameters<ApiContext['rpc']['getMultipleAccounts']>[1]) => ({
          send: async (transport?: { abortSignal?: AbortSignal }) => {
            counters.reads++
            if (mode === 'unavailable') throw new Error('Injected unavailable RPC')
            if (mode === 'account-timeout') return suspend(transport)
            const response = await target.getMultipleAccounts(addresses, options).send(transport)
            if (mode !== 'stale-slot' || options?.minContextSlot === undefined) return response
            return { ...response, context: { ...response.context, slot: BigInt(options.minContextSlot) - 1n } }
          },
        })
      }
      return Reflect.get(target, key)
    },
  })
  return { ctx: { ...base, rpc }, counters }
}

const stages = [
  'fault-localnet-preconditions', 'rpc-account-timeout', 'rpc-unavailable-incident',
  'rpc-stale-read-keeps-open', 'confirmation-timeout-keeps-open',
  'read-only-recheck-recovers-signature', 'fresh-complete-readback-resolves',
] as const

async function main(): Promise<void> {
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const reportFile = path.join(appRoot, '.dev', 'fault-report.json')
  const report = new AcceptanceReportBuilder(new Date().toISOString())
  let current = 0
  let exitCode = 0
  const line = (value: string) => { report.acceptLine(value); console.log(value) }
  const evidence = (value: Record<string, unknown>) => line(`EVIDENCE ${JSON.stringify(value)}`)
  const pass = () => { line(`PASS ${stages[current]}`); current++ }
  line(`ACCEPTANCE_RUN ${JSON.stringify({ stages })}`)
  try {
    const endpoint = process.env.AVEO_RPC_URL ?? 'http://127.0.0.1:8899'
    requireLocalFaultEndpoint(endpoint)
    const deployment = parseDeployment(JSON.parse(readFileSync(path.join(appRoot, '.dev', 'deployment.json'), 'utf8')))
    expect(deployment.cluster === 'localnet' && deployment.programs.aveoHook === AVEO_HOOK_PROGRAM_ID, 'Fault checks require the supported local deployment')
    const prior = JSON.parse(readFileSync(path.join(appRoot, '.dev', 'acceptance-report.json'), 'utf8')) as {
      status: string; startedAt: string; scope: string; stages: { id: string; status: string; evidence: { signature?: string; status?: string; mints?: string[] }[] }[]
    }
    expect(prior.status === 'PASS' && prior.scope === 'localnet-synthetic', 'Run demo:report successfully before fault checks')
    expect(Number.isFinite(Date.parse(deployment.generatedAt)) && Date.parse(prior.startedAt) >= Date.parse(deployment.generatedAt), 'Acceptance report belongs to an earlier fixture generation')
    const shared = prior.stages.find((stage) => stage.id === 'shared-proof-X')
    expect(shared?.status === 'PASS' && deployment.assets.every((asset) => shared.evidence.some((record) => record.mints?.includes(asset.mint))), 'Acceptance mints must match the current deployment')
    const external = prior.stages.find((stage) => stage.id === 'external-with-extra-accounts')
    const signature = external?.evidence.find((record) => record.status === 'confirmed')?.signature
    expect(external?.status === 'PASS' && signature && isSignature(signature), 'A real confirmed external signature is required')
    const x = deployment.wallets.find((wallet) => wallet.id === 'X')
    const treasury = deployment.wallets.find((wallet) => wallet.id === 'treasury')
    const alfa = deployment.assets.find((asset) => asset.id === 'alfa')
    expect(x && treasury && alfa && deployment.assets.length === 2, 'Fault checks require X, treasury and two fixture assets')
    const base = createApiContext({ cluster: 'localnet', rpcUrl: endpoint, commitment: 'confirmed', programId: deployment.programs.aveoHook, deployment })
    const healthy = faultContext(base, 'none')
    const inspectX = (ctx: ApiContext) => Promise.all(deployment.assets.map((asset) => inspectEligibility(ctx, asset.mint, x.address)))
    const baseline = await inspectX(healthy.ctx)
    expect(baseline.every((snapshot) => snapshot.verdict === 'eligible' && snapshot.read.slot > 0), 'Both X bindings must be eligible on the real local validator')
    const baselineSlot = Math.max(...baseline.map((snapshot) => snapshot.read.slot))
    let store = applyScan(EMPTY_STORE, baseline, baselineSlot, new Date().toISOString())
    evidence({ wallet: x.address, signature, slots: baseline.map((snapshot) => snapshot.read.slot) })
    pass()

    const timeout = faultContext(base, 'account-timeout')
    let timedOut = false
    try { await readAccounts(timeout.ctx, [await findPolicyPda(base.programId, alfa.mint)], undefined, 75) } catch (error) {
      timedOut = error instanceof DeskError && error.code === 'ReadUnverifiable'
    }
    expect(timedOut && timeout.counters.aborted === 1 && timeout.counters.sends === 0, 'Timed-out account reads must abort and fail closed without sending')
    evidence({ status: 'unknown', abortedRequests: timeout.counters.aborted, sendCalls: timeout.counters.sends })
    pass()

    const unavailable = faultContext(base, 'unavailable')
    const unknown = await inspectX(unavailable.ctx)
    expect(unknown.every((snapshot) => snapshot.verdict === 'unknown' && snapshot.actions.length === 0), 'Unavailable reads must not report eligibility or revocation')
    store = applyScan(store, unknown, baselineSlot, new Date().toISOString())
    const incident = store.incidents.find((item) => item.wallet === x.address && item.type === 'READ_UNVERIFIABLE')
    expect(incident && incident.affectedMints.length === 2, 'RPC failure must create one grouped read-unverifiable incident')
    evidence({ incidentType: incident.type, wallet: x.address, affectedMints: incident.affectedMints, verdicts: unknown.map((snapshot) => snapshot.verdict), sendCalls: unavailable.counters.sends })
    pass()

    const stale = faultContext(base, 'stale-slot')
    const inconsistent = await inspectX(stale.ctx)
    expect(inconsistent.every((snapshot) => snapshot.verdict === 'unknown'), 'A final account read older than discovery must be unknown')
    let pending = applyVerification(incident, inconsistent, new Date().toISOString())
    expect(pending.state !== 'resolved' && pending.events.at(-1)?.kind === 'unknown', 'Inconsistent reads cannot resolve the incident')
    evidence({ wallet: x.address, verdicts: inconsistent.map((snapshot) => snapshot.verdict), rpcReadCalls: stale.counters.reads, sendCalls: stale.counters.sends })
    pass()

    const confirmationTimeout = faultContext(base, 'confirmation-timeout')
    const result = await confirmSignature(confirmationTimeout.ctx, signature as Parameters<typeof confirmSignature>[1], 75)
    expect(result.status === 'unknown' && result.error?.code === 'ConfirmationUnknown' && confirmationTimeout.counters.aborted === 1, 'Hidden confirmation must remain unknown and abort at the deadline')
    pending = applySends(pending, [{ evidence: { ...result, signature } }], new Date().toISOString())
    pending = applyVerification(pending, inconsistent, new Date().toISOString())
    expect(pending.state !== 'resolved', 'Unknown confirmation and inconsistent readback must keep the incident unresolved')
    evidence({ signature, status: result.status, abortedRequests: confirmationTimeout.counters.aborted, sendCalls: confirmationTimeout.counters.sends })
    pass()

    const backend = new AveoSasHookBackend(healthy.ctx)
    const plan = await backend.planTransfer({ cluster: 'localnet', mint: alfa.mint, sourceOwner: treasury.address, destinationOwner: x.address, amount: 1n })
    const recovered = await recheckSubmission({ ctx: healthy.ctx, backend, plan, signature })
    expect(recovered.status === 'confirmed' && recovered.signature === signature && recovered.readback?.length === 2 && healthy.counters.sends === 0, 'Recovery must verify the original signature without submitting a transaction')
    evidence({ signature, status: recovered.status, slot: recovered.slot, sendCalls: healthy.counters.sends })
    pass()

    const fresh = await inspectX(healthy.ctx)
    pending = applyVerification(pending, fresh, new Date().toISOString())
    expect(pending.state === 'resolved' && pending.resolvedSlot !== undefined, 'Only a complete fresh eligible readback may resolve the read-unverifiable incident')
    expect([healthy, timeout, unavailable, stale, confirmationTimeout].every((fault) => fault.counters.sends === 0), 'Fault checks must never request a send')
    evidence({ wallet: x.address, slot: pending.resolvedSlot, verdicts: fresh.map((snapshot) => snapshot.verdict), sendCalls: 0 })
    pass()
  } catch (error) {
    exitCode = 1
    line(`FAIL ${stages[current]}: ${error instanceof FaultExpectation ? error.message : 'Check local validator and acceptance prerequisites'}`)
    for (const stage of stages.slice(current + 1)) line(`NOT_RUN ${stage}`)
  }
  const result = report.finish(exitCode, new Date().toISOString())
  mkdirSync(path.dirname(reportFile), { recursive: true })
  writeFileSync(reportFile, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
  console.log(`${result.status} fault-check (${current}/${stages.length}): ${reportFile}`)
  process.exitCode = result.status === 'PASS' ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('FAIL fault-check: could not finish the local report'); process.exitCode = 1 })
}
