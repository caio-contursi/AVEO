// Public evidence from the local acceptance runner; never store raw process logs.
import { ONCHAIN_ERRORS } from '@aveo/contracts'
import { isAddress, isSignature } from '@solana/kit'
import { z } from 'zod'

const address = z.string().refine(isAddress)
const slot = z.number().int().nonnegative().safe()
const amount = z.string().regex(/^\d+$/)

const evidenceSchema = z.object({
  signature: z.string().refine(isSignature).optional(),
  slot: slot.optional(),
  status: z.enum(['confirmed', 'failed', 'unknown']).optional(),
  hookCode: z.enum(ONCHAIN_ERRORS).optional(),
  wallet: address.optional(),
  source: address.optional(),
  destination: address.optional(),
  signer: address.optional(),
  protectedAccount: address.optional(),
  sharedProof: address.optional(),
  closedProof: address.optional(),
  proof: address.optional(),
  renewal: address.optional(),
  mints: z.array(address).optional(),
  affectedMints: z.array(address).optional(),
  slots: z.array(slot).optional(),
  beforeSlot: slot.optional(),
  afterSlot: slot.optional(),
  asset: z.enum(['alfa', 'beta']).optional(),
  accepted: z.boolean().optional(),
  accountUnchanged: z.boolean().optional(),
  before: z.array(amount).length(2).optional(),
  after: z.array(amount).length(2).optional(),
  amount: amount.optional(),
  delegatedAllowanceBefore: amount.optional(),
  delegatedAllowanceAfter: amount.optional(),
  incidentType: z.enum(['PROOF_CLOSED', 'PROOF_EXPIRED', 'PROVIDER_REMOVED', 'POLICY_CHANGED', 'READ_UNVERIFIABLE']).optional(),
  verdicts: z.array(z.enum(['eligible', 'ineligible', 'unknown'])).optional(),
  expiry: slot.optional(),
  clockUnix: slot.optional(),
  policyVersion: amount.optional(),
  policyActive: z.boolean().optional(),
  rpcReadCalls: slot.optional(),
  sendCalls: slot.optional(),
  abortedRequests: slot.optional(),
  faultTransport: z.enum(['sdk-injected', 'http-loopback']).optional(),
  validatorError: z.enum(['SignatureVerificationFailure', 'TokenInsufficientFunds']).optional(),
})

export type PublicEvidence = z.infer<typeof evidenceSchema>
export type CheckStatus = 'PASS' | 'FAIL' | 'NOT_RUN'

export interface StageResult {
  id: string
  status: CheckStatus
  evidence: PublicEvidence[]
}

const matrixCases = [
  ['T01', 'One shared SAS proof accepted by two assets', ['shared-proof-X', 'successful-transfers']],
  ['T02', 'Verifier B accepted by Alfa and rejected by Beta', ['policy-differences-Y-B-Z']],
  ['T03', 'Accreditation required only by Beta', ['policy-differences-Y-B-Z']],
  ['T04', 'Missing binding/proof and false KYC', []],
  ['T05', 'Wrong subject, mint and proof domain', []],
  ['T06', 'Expired proof blocks inbound and outbound transfers', ['short-lived-X-proof-bound', 'validator-clock-reaches-expiry', 'expired-proof-rejects-both-directions', 'valid-X-proof-bindings-restored']],
  ['T07', 'Authorized close blocks later transfers', ['close-X-proofs', 'rejected-transfers-unchanged-balances']],
  ['T08', 'Provider removed only from Alfa; Beta remains eligible', ['issuer-removes-A-alfa-only', 'issuer-restores-alfa-policy']],
  ['T09', 'New proof, wallet-signed rebind and verified resolution', ['issue-renewal-proof', 'signed-batched-rebind', 'fresh-readback', 'renewed-successful-transfers']],
  ['T10', 'Invalid accounts, layouts, schema and signer', []],
  ['T11', 'External transfer with and without extra accounts', ['external-with-extra-accounts', 'external-without-extra-accounts', 'external-expired-proof-rejected']],
  ['T12', 'Delegate transfer uses the token account owner', ['delegate-approved-owner-transfer', 'delegate-expired-owner-rejected', 'delegate-approval-revoked']],
  ['T13', 'Missing signatures and direct Execute invocation', ['direct-hook-execute-rejected', 'unsigned-policy-update-rejected', 'unsigned-binding-rejected']],
  ['T14', 'RPC/confirmation timeout and inconsistent reads', ['fault-localnet-preconditions', 'rpc-account-timeout', 'rpc-unavailable-incident', 'rpc-stale-read-keeps-open', 'confirmation-timeout-keeps-open', 'read-only-recheck-recovers-signature', 'fresh-complete-readback-resolves']],
  ['T15', 'Repeated scans and persistence after restart', []],
  ['T16', 'Same owner and boundary transfer amounts', ['boundary-zero-amount', 'boundary-excessive-amount', 'boundary-max-u64-rejected', 'boundary-exact-balance', 'boundary-same-owner-distinct-accounts', 'boundary-fixtures-restored']],
  ['T17', 'Inactive policy, paused schema and expiry boundaries', []],
] as const

export interface AcceptanceReport {
  version: 1
  scope: 'localnet-synthetic'
  startedAt: string
  finishedAt: string
  exitCode: number | null
  status: 'PASS' | 'FAIL'
  issues: string[]
  stages: StageResult[]
  matrix: { id: string; scenario: string; status: CheckStatus; stages: readonly string[]; note?: string }[]
}

const metadataSchema = z.object({
  stages: z.array(z.string().regex(/^[a-zA-Z0-9-]+$/).max(100)).min(1).max(100),
}).refine((metadata) => new Set(metadata.stages).size === metadata.stages.length)

export class AcceptanceReportBuilder {
  private stages: StageResult[] = []
  private current = 0
  private readonly issues: string[] = []

  constructor(private readonly startedAt: string) {}

  acceptLine(line: string): void {
    if (line.startsWith('ACCEPTANCE_RUN ')) {
      try {
        const metadata = metadataSchema.parse(JSON.parse(line.slice('ACCEPTANCE_RUN '.length)))
        if (this.stages.length !== 0) throw new Error('duplicate metadata')
        this.stages = metadata.stages.map((id) => ({ id, status: 'NOT_RUN', evidence: [] }))
      } catch {
        this.issues.push('Invalid or duplicate runner metadata')
      }
      return
    }
    if (line.startsWith('EVIDENCE ')) {
      try {
        const evidence = evidenceSchema.parse(JSON.parse(line.slice('EVIDENCE '.length)))
        const stage = this.stages[this.current]
        if (!stage || Object.keys(evidence).length === 0) throw new Error('missing evidence stage')
        stage.evidence.push(evidence)
      } catch {
        this.issues.push('Invalid public evidence record')
      }
      return
    }
    const terminal = /^(PASS|FAIL|NOT_RUN) ([a-zA-Z0-9-]+)(?::.*)?$/.exec(line)
    if (!terminal) return
    const stage = this.stages[this.current]
    if (!stage || stage.id !== terminal[2]) {
      this.issues.push('Unexpected acceptance stage order')
      return
    }
    stage.status = terminal[1] as CheckStatus
    this.current += 1
  }

  finish(exitCode: number | null, finishedAt: string): AcceptanceReport {
    const allPassed = this.stages.length > 0 && this.current === this.stages.length && this.stages.every((stage) => stage.status === 'PASS')
    const matrix = matrixCases.map(([id, scenario, required]) => {
      const results = required.map((stage) => this.stages.find((result) => result.id === stage)?.status ?? 'NOT_RUN')
      const status: CheckStatus = results.includes('FAIL') ? 'FAIL' : results.length > 0 && results.every((result) => result === 'PASS') ? 'PASS' : 'NOT_RUN'
      return {
        id, scenario, status, stages: required,
        ...(required.length === 0 ? { note: 'This full matrix case is not exercised by this acceptance runner; partial or unit coverage is not a PASS.' } : {}),
      }
    })
    return {
      version: 1, scope: 'localnet-synthetic', startedAt: this.startedAt, finishedAt, exitCode,
      status: exitCode === 0 && allPassed && this.issues.length === 0 ? 'PASS' : 'FAIL',
      issues: [...this.issues],
      stages: this.stages.map((stage) => ({ ...stage, evidence: [...stage.evidence] })),
      matrix,
    }
  }
}
