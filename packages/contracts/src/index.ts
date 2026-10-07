export type BackendId = 'aveo-sas-hook' | 'mpl3643';
export type Verdict = 'eligible' | 'ineligible' | 'unknown';
export type Capability = 'transfer' | 'renew-binding' | 'refreeze';
export type Cluster = 'localnet' | 'devnet';
export type Side = 'source' | 'destination';

export const ONCHAIN_ERRORS = [
  'NotTransferContext',
  'PolicyMissingOrInactive',
  'MintMismatch',
  'BindingMissing',
  'BindingSubjectMismatch',
  'ProviderPairNotAllowed',
  'SchemaMismatchOrPaused',
  'AttestationMissingOrClosed',
  'InvalidSasOwnerOrData',
  'UnauthorizedAttestationSigner',
  'SubjectMismatch',
  'ProofDomainMismatch',
  'RequiredFactMissing',
  'AttestationExpired',
  'MissingExtraAccounts',
  'UnauthorizedIssuer',
] as const;
export type OnchainError = (typeof ONCHAIN_ERRORS)[number];

/** Anchor custom errors start at 6000 and follow ONCHAIN_ERRORS order. */
export function onchainErrorFromCode(code: number): OnchainError | undefined {
  return ONCHAIN_ERRORS[code - 6000];
}

export type DeskErrorCode =
  | 'BackendNotIntegrated'
  | 'UnsupportedCapability'
  | 'ReadUnverifiable'
  | 'SimulationFailed'
  | 'ConfirmationUnknown';

export class DeskError extends Error {
  constructor(
    readonly code: DeskErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'DeskError';
  }
}

export interface ReadContext {
  cluster: Cluster;
  rpcUrl: string;
  slot: number;
  commitment: 'processed' | 'confirmed' | 'finalized';
  observedAt: string;
}

export interface InspectInput {
  cluster: Cluster;
  mint: string;
  wallet: string;
}

export interface SourceAccounts {
  policy?: string;
  binding?: string;
  credential?: string;
  schema?: string;
  attestation?: string;
}

export interface Reason {
  code: OnchainError | DeskErrorCode;
  message: string;
}

export interface EligibilitySnapshot {
  backend: BackendId;
  read: ReadContext;
  mint: string;
  wallet: string;
  policyVersion?: bigint;
  verdict: Verdict;
  reasons: Reason[];
  sourceAccounts: SourceAccounts;
  expiresAt?: string;
  actions: Capability[];
}

export interface TransferInput {
  cluster: Cluster;
  mint: string;
  sourceOwner: string;
  destinationOwner: string;
  amount: bigint;
}

export interface UnsignedPlan {
  backend: BackendId;
  /** Base64 serialized unsigned transaction; never contains private keys. */
  transaction: string;
  requiredSigners: string[];
  summary: string[];
  diagnostics: { source: EligibilitySnapshot; destination: EligibilitySnapshot };
}

export interface VerifyInput {
  cluster: Cluster;
  signature?: string;
  plan: UnsignedPlan;
}

export type OutcomeStatus = 'confirmed' | 'failed' | 'unknown';

export interface OperationEvidence {
  status: OutcomeStatus;
  signature?: string;
  slot?: number;
  logs: string[];
  error?: Reason & { side?: Side };
  readback?: EligibilitySnapshot[];
}

export interface EligibilityBackend {
  readonly id: BackendId;
  capabilities(): readonly Capability[];
  inspect(input: InspectInput): Promise<EligibilitySnapshot>;
  planTransfer(input: TransferInput): Promise<UnsignedPlan>;
  verifyOutcome(input: VerifyInput): Promise<OperationEvidence>;
}

export interface RenewBindingInput {
  cluster: Cluster;
  /** Kept for existing callers. Ignored when `mints` is non-empty. */
  mint: string;
  /**
   * One unsigned transaction with one `set_binding` per mint.
   * A shared proof that covers Alfa and Beta is signed once.
   */
  mints?: readonly string[];
  wallet: string;
  attestation: string;
}

export interface RenewBindingCapable {
  planRenewBinding(input: RenewBindingInput): Promise<UnsignedPlan>;
}

export type IncidentType =
  | 'PROOF_EXPIRED'
  | 'PROOF_CLOSED'
  | 'PROVIDER_REMOVED'
  | 'POLICY_CHANGED'
  | 'READ_UNVERIFIABLE';

export type IncidentState = 'open' | 'action-prepared' | 'awaiting-confirmation' | 'resolved';

export interface Incident {
  id: string;
  type: IncidentType;
  state: IncidentState;
  wallet: string;
  proof: string;
  affectedMints: string[];
  detectedAt: string;
  detectedSlot: number;
  evidence: OperationEvidence[];
}
