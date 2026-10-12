// Backend B do Desk (aveo-sas-hook) implementado no front, sobre o RPC: inspect, plan e verify.
// Segue o contrato EligibilityBackend / RenewBindingCapable de @aveo/contracts (spec v3, seção 7).
// O pacote packages/backend-aveo previsto no plano está vazio.
import { AVEO_BACKEND_CAPABILITIES, renewalMints } from '@aveo/backend-aveo'
import type {
  Capability,
  EligibilityBackend,
  InspectInput,
  OperationEvidence,
  RenewBindingCapable,
  RenewBindingInput,
  TransferInput,
  UnsignedPlan,
  VerifyInput,
} from '@aveo/contracts'
import { address, type Address, type Signature } from '@solana/kit'
import { readAccount } from './accounts'
import { throwIfReadAborted, withReadAbort } from './cancellation'
import { decodeSasAttestation, type PolicyArgs } from './codecs'
import type { ApiContext } from './context'
import type { DeskSnapshot, DiagnosticReason } from './diagnostics'
import { inspectEligibility } from './eligibility'
import { withDiagnosticParams } from './explain'
import {
  PlanBlockedError,
  confirmSignature,
  planRequest,
  requiredSignerOf,
  tokenBalances,
  type PlanRequest,
  type SimulationOutcome,
} from './transactions'

export interface DeskPlan extends UnsignedPlan {
  request: PlanRequest
  simulation: SimulationOutcome
  diagnostics: { source: DeskSnapshot; destination: DeskSnapshot }
  /** Preenchido quando nem dá para montar a transação (ex.: conta extra impossível de resolver). */
  blocked?: DiagnosticReason
}

export interface BalanceReadback {
  owner: Address
  before?: bigint
  after: bigint
}

export interface DeskEvidence extends OperationEvidence {
  readback?: DeskSnapshot[]
  balances?: BalanceReadback[]
}

export class AveoSasHookBackend implements EligibilityBackend, RenewBindingCapable {
  readonly id = 'aveo-sas-hook' as const
  readonly ctx: ApiContext

  constructor(ctx: ApiContext) {
    this.ctx = ctx
  }

  capabilities(): readonly Capability[] {
    return AVEO_BACKEND_CAPABILITIES
  }

  inspect(input: InspectInput, readAbortSignal?: AbortSignal): Promise<DeskSnapshot> {
    const ctx = this.readContext(readAbortSignal)
    return withReadAbort(readAbortSignal, () => inspectEligibility(ctx, address(input.mint), address(input.wallet)))
  }

  private readContext(readAbortSignal?: AbortSignal): ApiContext {
    return readAbortSignal ? { ...this.ctx, readAbortSignal } : this.ctx
  }

  private async plan(request: PlanRequest, diagnostics: DeskPlan['diagnostics'], summary: string[], ctx = this.ctx): Promise<DeskPlan> {
    const base = { backend: this.id, requiredSigners: [requiredSignerOf(request)], summary, diagnostics, request }
    try {
      const { simulation, transaction } = await withReadAbort(ctx.readAbortSignal, () => planRequest(ctx, request))
      return { ...base, transaction, simulation: { ...simulation, error: withDiagnosticParams(simulation.error, base) } }
    } catch (error) {
      throwIfReadAborted(ctx.readAbortSignal)
      if (error instanceof PlanBlockedError) {
        return { ...base, transaction: '', simulation: { ok: false, logs: [], error: error.reason }, blocked: error.reason }
      }
      throw error
    }
  }

  async planTransfer(input: TransferInput, readAbortSignal?: AbortSignal): Promise<DeskPlan> {
    throwIfReadAborted(readAbortSignal)
    const ctx = this.readContext(readAbortSignal)
    const mint = address(input.mint)
    const sourceOwner = address(input.sourceOwner)
    const destinationOwner = address(input.destinationOwner)
    const asset = this.ctx.deployment.assets.find((a) => a.mint === mint)
    const [source, destination] = await withReadAbort(readAbortSignal, () => Promise.all([
      inspectEligibility(ctx, mint, sourceOwner),
      inspectEligibility(ctx, mint, destinationOwner),
    ]))
    throwIfReadAborted(readAbortSignal)
    return this.plan(
      { kind: 'transfer', mint, sourceOwner, destinationOwner, amount: input.amount, decimals: asset?.decimals ?? 0 },
      { source, destination },
      [`transfer ${input.amount} of ${mint} from ${sourceOwner} to ${destinationOwner}`],
      ctx,
    )
  }

  async planRenewBinding(input: RenewBindingInput, readAbortSignal?: AbortSignal): Promise<DeskPlan> {
    throwIfReadAborted(readAbortSignal)
    const ctx = this.readContext(readAbortSignal)
    const mints = renewalMints(input).map((mint) => address(mint))
    const wallet = address(input.wallet)
    const attestationAddress = address(input.attestation)
    const { account } = await withReadAbort(readAbortSignal, () => readAccount(ctx, attestationAddress))
    throwIfReadAborted(readAbortSignal)
    if (!account) throw new PlanBlockedError({ code: 'AttestationMissingOrClosed', message: 'attestation not found' })
    if (mints.length === 0) throw new PlanBlockedError({ code: 'MintMismatch', message: 'no mint to bind' })
    const attestation = decodeSasAttestation(account.data)
    const snapshots = await withReadAbort(readAbortSignal, () => Promise.all(mints.map((mint) => inspectEligibility(ctx, mint, wallet))))
    throwIfReadAborted(readAbortSignal)
    return this.plan(
      {
        kind: 'set-binding',
        mints,
        wallet,
        credential: attestation.credential,
        schema: attestation.schema,
        attestation: attestationAddress,
      },
      { source: snapshots[0]!, destination: snapshots[snapshots.length - 1]! },
      mints.map((mint) => `bind ${attestationAddress} to ${wallet} in ${mint}`),
      ctx,
    )
  }

  async planUpdatePolicy(input: { mint: string; authority: string; args: PolicyArgs }, readAbortSignal?: AbortSignal): Promise<DeskPlan> {
    throwIfReadAborted(readAbortSignal)
    const ctx = this.readContext(readAbortSignal)
    const mint = address(input.mint)
    const authority = address(input.authority)
    const snapshot = await withReadAbort(readAbortSignal, () => inspectEligibility(ctx, mint, authority))
    throwIfReadAborted(readAbortSignal)
    return this.plan({ kind: 'update-policy', mint, authority, args: input.args }, { source: snapshot, destination: snapshot }, [
      `update policy of ${mint}`,
    ], ctx)
  }

  /** Verifica com leitura nova: status da assinatura, logs e readback das partes. */
  async verifyOutcome(input: VerifyInput & { balancesBefore?: bigint[] }): Promise<DeskEvidence> {
    const plan = input.plan as DeskPlan
    if (!input.signature) {
      return { status: 'failed', logs: plan.simulation.logs, error: plan.simulation.error }
    }
    const confirmation = await confirmSignature(this.ctx, input.signature as Signature)
    const evidence: DeskEvidence = {
      status: confirmation.status,
      signature: input.signature,
      slot: confirmation.slot,
      logs: confirmation.logs,
      error: withDiagnosticParams(confirmation.error, plan),
    }
    if (confirmation.status === 'unknown') return evidence

    const request = plan.request
    if (request.kind === 'transfer') {
      const owners = [request.sourceOwner, request.destinationOwner]
      const [readback, balances] = await Promise.all([
        Promise.all(owners.map((owner) => inspectEligibility(this.ctx, request.mint, owner))),
        tokenBalances(this.ctx, request.mint, owners),
      ])
      evidence.readback = readback
      evidence.balances = owners.map((owner, i) => ({ owner, before: input.balancesBefore?.[i], after: balances.balances[i] ?? 0n }))
    } else if (request.kind === 'set-binding') {
      evidence.readback = await Promise.all(request.mints.map((mint) => inspectEligibility(this.ctx, mint, request.wallet)))
    } else {
      evidence.readback = [await inspectEligibility(this.ctx, request.mint, request.authority)]
    }
    return evidence
  }
}
