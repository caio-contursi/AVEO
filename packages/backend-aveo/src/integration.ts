import { DeskError } from '@aveo/contracts'
import type {
  Cluster,
  EligibilityBackend,
  EligibilitySnapshot,
  OperationEvidence,
  Side,
  TransferInput,
  UnsignedPlan,
} from '@aveo/contracts'

type TransferContext = Pick<TransferInput, 'cluster' | 'mint' | 'sourceOwner' | 'destinationOwner'>

function checkSnapshot(
  backend: EligibilityBackend,
  snapshot: EligibilitySnapshot,
  input: TransferContext,
  side: Side,
): void {
  const wallet = side === 'source' ? input.sourceOwner : input.destinationOwner
  if (snapshot.backend !== backend.id || snapshot.read.cluster !== input.cluster
    || snapshot.mint !== input.mint || snapshot.wallet !== wallet) {
    throw new DeskError('ReadUnverifiable', `${side} diagnostics do not match the requested backend, cluster, mint or wallet.`)
  }
}

function requireEligible(snapshot: EligibilitySnapshot, side: Side): void {
  if (snapshot.verdict === 'eligible') return
  const reasons = snapshot.reasons.map((reason) => `${reason.code}: ${reason.message}`).join('; ')
  throw new DeskError(
    snapshot.verdict === 'ineligible' ? 'SimulationFailed' : 'ReadUnverifiable',
    `${side} eligibility is ${snapshot.verdict}.${reasons ? ` ${reasons}` : ''}`,
  )
}

function checkDiagnostics(
  backend: EligibilityBackend,
  diagnostics: UnsignedPlan['diagnostics'],
  input: TransferContext,
): void {
  const { source, destination } = diagnostics
  checkSnapshot(backend, source, input, 'source')
  checkSnapshot(backend, destination, input, 'destination')
  if (source.read.rpcUrl !== destination.read.rpcUrl
    || source.read.commitment !== destination.read.commitment) {
    throw new DeskError('ReadUnverifiable', 'Source and destination diagnostics use different RPC URLs or commitments.')
  }
}

function checkPlan(backend: EligibilityBackend, plan: UnsignedPlan, input: TransferContext): void {
  if (plan.backend !== backend.id) {
    throw new DeskError('ReadUnverifiable', 'Plan backend does not match the supplied backend.')
  }
  checkDiagnostics(backend, plan.diagnostics, input)
  if (!plan.requiredSigners.includes(input.sourceOwner)) {
    throw new DeskError('ReadUnverifiable', 'Plan must require the source owner as a signer.')
  }
  if (!plan.transaction.trim()) {
    throw new DeskError('SimulationFailed', 'Backend returned no unsigned transaction.')
  }
}

/** Diagnose both subjects independently; blocked and unknown verdicts remain visible. */
export async function inspectTransfer(
  backend: EligibilityBackend,
  input: TransferInput,
): Promise<UnsignedPlan['diagnostics']> {
  const [source, destination] = await Promise.all([
    backend.inspect({ cluster: input.cluster, mint: input.mint, wallet: input.sourceOwner }),
    backend.inspect({ cluster: input.cluster, mint: input.mint, wallet: input.destinationOwner }),
  ])
  const diagnostics = { source, destination }
  checkDiagnostics(backend, diagnostics, input)
  return diagnostics
}

/** Plan for review using backend diagnostics; metadata checks are not authorization. */
export async function prepareTransfer(
  backend: EligibilityBackend,
  input: TransferInput,
): Promise<UnsignedPlan> {
  if (!backend.capabilities().includes('transfer')) {
    throw new DeskError('UnsupportedCapability', 'Backend does not support transfer planning.')
  }
  const plan = await backend.planTransfer(input)
  checkPlan(backend, plan, input)
  requireEligible(plan.diagnostics.source, 'source')
  requireEligible(plan.diagnostics.destination, 'destination')
  return plan
}

/** Delegate evidence reads; this does not bind a signature to the plan's transaction. */
export async function verifyPreparedTransfer(
  backend: EligibilityBackend,
  plan: UnsignedPlan,
  cluster: Cluster,
  signature?: string,
): Promise<OperationEvidence> {
  // UnsignedPlan has no original request. These checks establish only internal consistency.
  checkPlan(backend, plan, {
    cluster,
    mint: plan.diagnostics.source.mint,
    sourceOwner: plan.diagnostics.source.wallet,
    destinationOwner: plan.diagnostics.destination.wallet,
  })
  if (!signature?.trim()) {
    return {
      status: 'unknown',
      logs: [],
      error: { code: 'ConfirmationUnknown', message: 'No signature supplied; no execution evidence is available.' },
    }
  }
  return backend.verifyOutcome({ cluster, plan, signature })
}
