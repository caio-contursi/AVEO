// One synthetic localnet submission, followed exclusively by signature recovery reads.
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import {
  appendTransactionMessageInstructions, createTransactionMessage,
  getBase64EncodedWireTransaction, getSignatureFromTransaction,
  setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners, type Address, type KeyPairSigner, type Signature,
} from '@solana/kit'
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget'
import { AveoSasHookBackend, type DeskPlan } from '../src/api/backend'
import { readAccounts } from '../src/api/accounts'
import { AVEO_HOOK_PROGRAM_ID } from '../src/api/constants'
import { createApiContext, type ApiContext } from '../src/api/context'
import { decodeTokenBalance } from '../src/api/token-balance'
import { buildInstructions, confirmSignature, simulate, tokenAccountsFor } from '../src/api/transactions'
import { parseDeployment, type Deployment } from '../src/config/deployment'

export class RecoveryCheckError extends Error {
  constructor() { super('Local recovery acceptance failed; check local validator, fresh synthetic fixtures and prerequisites.') }
}
function requireCheck(condition: unknown): asserts condition {
  if (!condition) throw new RecoveryCheckError()
}

/** Literal loopback only: no DNS, credentials, query strings or RPC proxy paths. */
export function validateLocalEndpoints(cluster: string, rpcUrl: string, wsUrl: string): void {
  requireCheck(cluster === 'localnet')
  for (const [raw, protocols] of [[rpcUrl, ['http:', 'https:']], [wsUrl, ['ws:', 'wss:']]] as const) {
    let url: URL
    try { url = new URL(raw) } catch { throw new RecoveryCheckError() }
    requireCheck(protocols.some((protocol) => protocol === url.protocol) &&
      ['127.0.0.1', '[::1]'].includes(url.hostname) && !url.username && !url.password &&
      !url.search && !url.hash && url.pathname === '/')
    // Reject alternate numeric spellings normalized by URL, including non-loopback-looking input.
    requireCheck(/^\w+:\/\/(127\.0\.0\.1|\[::1\])(?::\d+)?\/?$/.test(raw))
  }
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}

/** Require an existing external temporary directory; never fall back to app/.dev. */
export function validateFixtureDirectory(directory: string | undefined, repository: string): string {
  try {
    requireCheck(directory && path.isAbsolute(directory))
    const resolved = realpathSync(directory)
    const repo = realpathSync(repository)
    requireCheck(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink() &&
      inside(realpathSync(tmpdir()), resolved) && resolved !== repo && !inside(repo, resolved))
    for (const name of ['deployment.json', 'wallets.json']) {
      const file = path.join(resolved, name)
      requireCheck(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink() && path.dirname(realpathSync(file)) === resolved)
    }
    return resolved
  } catch { throw new RecoveryCheckError() }
}

/** Even a transport ignoring AbortSignal cannot keep this acceptance stage open. */
export async function bounded<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  requireCheck(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60_000)
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { reject(new RecoveryCheckError()); controller.abort() }, timeoutMs)
      }),
    ])
  } catch { throw new RecoveryCheckError() }
  finally { clearTimeout(timer) }
}

/** Clone the context: submission and every non-confirmation method still use the real RPC. */
export function unavailableConfirmationContext(ctx: ApiContext, mode: 'unavailable' | 'hanging' = 'hanging') {
  const counters = { statuses: 0, transactions: 0 }
  const rpc = new Proxy(ctx.rpc, {
    get(target, property, receiver) {
      if (property === 'getSignatureStatuses' || property === 'getTransaction') {
        return () => ({ send: () => {
          if (property === 'getSignatureStatuses') counters.statuses++
          else counters.transactions++
          return mode === 'hanging' ? new Promise<never>(() => {}) : Promise.reject(new RecoveryCheckError())
        } })
      }
      return Reflect.get(target, property, receiver)
    },
  })
  return { ctx: { ...ctx, rpc }, counters }
}

export interface RecoveryEvidence {
  version: 1
  scope: 'localnet-synthetic'
  status: 'pending' | 'unknown' | 'PASS'
  signature: Signature
  mint: Address
  source: Address
  destination: Address
  amount: '1'
  signatures: number
  submissions: number
  confirmationReadFaults: number
  before: string[]
  after?: string[]
  confirmationSlot?: number
  balanceSlot?: number
  hookSuccess?: string
}

async function freshBalances(ctx: ApiContext, mint: Address, owners: Address[], floor: number) {
  const addresses = await tokenAccountsFor(mint, owners)
  const read = await readAccounts(ctx, addresses, floor)
  requireCheck(read.accounts.every(Boolean))
  return { slot: read.slot, balances: read.accounts.map((account, index) =>
    decodeTokenBalance(account, { address: addresses[index]!, mint, owner: owners[index]! })) }
}

async function signOnce(ctx: ApiContext, plan: DeskPlan, signer: KeyPairSigner, signal: AbortSignal) {
  const instructions = await buildInstructions({ ...ctx, readAbortSignal: signal }, plan.request, signer)
  const approved = await simulate({ ...ctx, readAbortSignal: signal }, instructions, signer.address)
  requireCheck(approved.ok)
  const { value: blockhash } = await ctx.rpc.getLatestBlockhash({ commitment: 'confirmed' }).send({ abortSignal: signal })
  requireCheck(!signal.aborted)
  const units = Math.min(1_400_000, Math.ceil((approved.unitsConsumed ?? 400_000) * 1.3))
  let message = setTransactionMessageFeePayerSigner(signer, createTransactionMessage({ version: 0 }))
  message = setTransactionMessageLifetimeUsingBlockhash(blockhash, message)
  const signed = await signTransactionMessageWithSigners(appendTransactionMessageInstructions([
    getSetComputeUnitLimitInstruction({ units }), ...instructions,
  ], message))
  return { signature: getSignatureFromTransaction(signed), wire: getBase64EncodedWireTransaction(signed) }
}

export const recoveryDependencies = {
  plan: (ctx: ApiContext, mint: Address, source: Address, destination: Address, signal: AbortSignal) =>
    new AveoSasHookBackend(ctx).planTransfer({ cluster: 'localnet', mint, sourceOwner: source, destinationOwner: destination, amount: 1n }, signal),
  balances: freshBalances,
  sign: signOnce,
}

/** Dependency injection lets tests use no keys, network or fixture files. No resend path exists. */
export async function runLocalRecoveryCheck(input: {
  ctx: ApiContext
  wsUrl: string
  generatedX: KeyPairSigner
  verifyLocalValidator: () => Promise<void>
  persist: (evidence: RecoveryEvidence) => void
  dependencies?: typeof recoveryDependencies
  faultMode?: 'unavailable' | 'hanging'
  faultTimeoutMs?: number
  recoveryTimeoutMs?: number
}): Promise<RecoveryEvidence> {
  try {
    const { ctx, generatedX, persist } = input
    const faultMs = input.faultTimeoutMs ?? 75
    const recoveryMs = input.recoveryTimeoutMs ?? 15_000
    requireCheck(Number.isSafeInteger(faultMs) && faultMs > 0 && faultMs <= 1000 &&
      Number.isSafeInteger(recoveryMs) && recoveryMs > 0 && recoveryMs <= 30_000)
    validateLocalEndpoints(ctx.cluster, ctx.rpcUrl, input.wsUrl)
    requireCheck(ctx.commitment === 'confirmed' && ctx.deployment.cluster === 'localnet' && ctx.programId === AVEO_HOOK_PROGRAM_ID)
    const { asset, x, treasury } = recoverySubjects(ctx.deployment)
    requireCheck(generatedX.address === x.address)
    const deps = input.dependencies ?? recoveryDependencies
    const plan = await bounded((signal) => deps.plan(ctx, asset.mint, x.address, treasury.address, signal), 15_000)
    requireCheck(!plan.blocked && plan.simulation.ok && plan.request.kind === 'transfer' &&
      plan.request.mint === asset.mint && plan.request.sourceOwner === x.address &&
      plan.request.destinationOwner === treasury.address && plan.request.amount === 1n &&
      plan.request.decimals === asset.decimals && plan.requiredSigners.length === 1 && plan.requiredSigners[0] === x.address)
    for (const [snapshot, owner] of [[plan.diagnostics.source, x.address], [plan.diagnostics.destination, treasury.address]] as const) {
      requireCheck(snapshot.verdict === 'eligible' && snapshot.mint === asset.mint && snapshot.wallet === owner &&
        snapshot.read.cluster === 'localnet' && snapshot.read.rpcUrl === ctx.rpcUrl && snapshot.read.commitment === 'confirmed' &&
        Number.isSafeInteger(snapshot.read.slot) && snapshot.read.slot > 0 && snapshot.proof &&
        snapshot.sourceAccounts.attestation === snapshot.proof.attestation &&
        Number.isSafeInteger(snapshot.clockUnix) && snapshot.clockUnix !== undefined &&
        snapshot.proof.expiry - BigInt(snapshot.clockUnix) >= 120n)
    }
    const floor = Math.max(plan.diagnostics.source.read.slot, plan.diagnostics.destination.read.slot)
    const owners = [x.address, treasury.address]
    const before = await bounded((signal) => deps.balances({ ...ctx, readAbortSignal: signal }, asset.mint, owners, floor), 10_000)
    requireCheck(before.slot >= floor && before.balances.length === 2 && before.balances[0]! >= 1n)
    // Capture and persist the SDK signature before the sole raw submission.
    await bounded(() => input.verifyLocalValidator(), 10_000)
    const signed = await bounded((signal) => deps.sign(ctx, plan, generatedX, signal), 15_000)
    const evidence: RecoveryEvidence = { version: 1, scope: 'localnet-synthetic', status: 'pending',
      signature: signed.signature, mint: asset.mint, source: x.address, destination: treasury.address,
      amount: '1', signatures: 1, submissions: 0, confirmationReadFaults: 0, before: before.balances.map(String) }
    persist({ ...evidence })
    await bounded(() => input.verifyLocalValidator(), 10_000)
    evidence.submissions++
    persist({ ...evidence })
    const returnedSignature = await bounded((signal) => ctx.rpc.sendTransaction(signed.wire, {
      encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0n,
    }).send({ abortSignal: signal }), 10_000)
    requireCheck(returnedSignature === signed.signature)
    const fault = unavailableConfirmationContext(ctx, input.faultMode)
    const unknown = await confirmSignature(fault.ctx, signed.signature, faultMs)
    requireCheck(unknown.status === 'unknown' && fault.counters.statuses > 0)
    evidence.status = 'unknown'
    evidence.confirmationReadFaults = fault.counters.statuses + fault.counters.transactions
    persist({ ...evidence })
    const confirmed = await bounded(() => confirmSignature(ctx, signed.signature, recoveryMs), recoveryMs + 100)
    const hookSuccess = `Program ${ctx.programId} success`
    requireCheck(confirmed.status === 'confirmed' && Number.isSafeInteger(confirmed.slot) && confirmed.slot! > 0 && confirmed.logs.includes(hookSuccess))
    const after = await bounded((signal) => deps.balances({ ...ctx, readAbortSignal: signal }, asset.mint, owners,
      Math.max(before.slot, confirmed.slot!)), 10_000)
    requireCheck(after.slot >= Math.max(before.slot, confirmed.slot!) && after.balances.length === 2 &&
      before.balances[0]! - after.balances[0]! === 1n && after.balances[1]! - before.balances[1]! === 1n &&
      evidence.signatures === 1 && evidence.submissions === 1)
    Object.assign(evidence, { status: 'PASS', after: after.balances.map(String),
      confirmationSlot: confirmed.slot, balanceSlot: after.slot, hookSuccess })
    persist({ ...evidence })
    return evidence
  } catch { throw new RecoveryCheckError() }
}

export function recoverySubjects(deployment: Deployment) {
  requireCheck(deployment.cluster === 'localnet' && deployment.programs.aveoHook === AVEO_HOOK_PROGRAM_ID &&
    Number.isFinite(Date.parse(deployment.generatedAt)))
  const assets = deployment.assets.filter((asset) => asset.id === 'alfa')
  const xs = deployment.wallets.filter((wallet) => wallet.id === 'X' && wallet.role === 'investor')
  const treasuries = deployment.wallets.filter((wallet) => wallet.id === 'treasury' && wallet.role === 'treasury')
  requireCheck(assets.length === 1 && xs.length === 1 && treasuries.length === 1 && xs[0]!.address !== treasuries[0]!.address)
  return { asset: assets[0]!, x: xs[0]!, treasury: treasuries[0]! }
}

export async function main(): Promise<void> {
  const rpcUrl = process.env.AVEO_RPC_URL ?? 'http://127.0.0.1:8899'
  const wsUrl = process.env.AVEO_WS_URL ?? 'ws://127.0.0.1:8900'
  validateLocalEndpoints(process.env.AVEO_CLUSTER ?? 'localnet', rpcUrl, wsUrl)
  requireCheck(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(process.env.AVEO_LOCAL_GENESIS_HASH ?? ''))
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const directory = validateFixtureDirectory(process.env.AVEO_DEV_DIR, repo)
  // Read only the public manifest until both endpoints, location and cluster are checked.
  const publicDeployment = parseDeployment(JSON.parse(readFileSync(path.join(directory, 'deployment.json'), 'utf8')),
    { cluster: 'localnet', programId: AVEO_HOOK_PROGRAM_ID })
  recoverySubjects(publicDeployment)
  const lib = await import('./lib')
  requireCheck(realpathSync(lib.DEV_DIR) === directory && lib.RPC_URL === rpcUrl && lib.WS_URL === wsUrl &&
    lib.WALLETS_FILE === path.join(directory, 'wallets.json') && lib.DEPLOYMENT_FILE === path.join(directory, 'deployment.json'))
  await bounded(() => lib.verifyLocalValidator(), 10_000)
  const deployment = parseDeployment(lib.loadDeployment(), { cluster: 'localnet', programId: AVEO_HOOK_PROGRAM_ID })
  const { x } = recoverySubjects(deployment)
  const wallets = await bounded(() => lib.loadDevWallets(), 10_000)
  const generatedX = wallets.get('X')
  requireCheck(generatedX?.record.role === 'investor' && generatedX.signer.address === x.address)
  const ctx = createApiContext({ cluster: 'localnet', rpcUrl, commitment: 'confirmed', programId: deployment.programs.aveoHook, deployment })
  const report = path.join(directory, `local-recovery-${randomUUID()}.json`)
  // Create exclusively; an existing file or symlink must never be overwritten.
  writeFileSync(report, '{}\n', { flag: 'wx', mode: 0o600 })
  const result = await runLocalRecoveryCheck({ ctx, wsUrl, generatedX: generatedX.signer,
    verifyLocalValidator: () => lib.verifyLocalValidator(),
    persist: (evidence) => writeFileSync(report, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 }) })
  console.log(`PASS local-recovery-check: ${result.signature}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error(new RecoveryCheckError().message); process.exitCode = 1 })
}
