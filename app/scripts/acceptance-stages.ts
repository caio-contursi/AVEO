// Demo acceptance contract only: importing this module never starts a runner or reads fixtures.
// Version changes describe stage-contract changes, independently of the report schema version.
import { SCHEMA_VALIDITY_STAGES } from './schema-validity-checks'
import { SAS_ADVERSARIAL_STAGES } from './sas-adversarial-checks'
import { MISSING_BINDING_STAGES } from './missing-binding-checks'

export const DEMO_ACCEPTANCE_MANIFEST = Object.freeze({
  version: 3,
  stageIds: Object.freeze([
    'localnet-preconditions', 'shared-proof-X', 'successful-transfers',
    'external-with-extra-accounts', 'external-without-extra-accounts',
    'direct-hook-execute-rejected', 'unsigned-policy-update-rejected', 'unsigned-binding-rejected',
    'boundary-zero-amount', 'boundary-excessive-amount', 'boundary-max-u64-rejected', 'boundary-exact-balance',
    'boundary-same-owner-distinct-accounts', 'boundary-fixtures-restored',
    'delegate-approved-owner-transfer', 'policy-differences-Y-B-Z',
    'non-issuer-policy-update-rejected', 'wrong-subject-binding-rejected',
    'false-kyc-proof-bound', 'false-kyc-transfers-rejected', 'false-kyc-original-bindings-restored',
    'close-X-proofs', 'rejected-transfers-unchanged-balances', 'scan-grouping',
    'persistence-initial-save', 'persistence-process-restart', 'persistence-repeated-scan',
    'issue-renewal-proof', 'signed-batched-rebind', 'fresh-readback', 'renewed-successful-transfers',
    'issuer-removes-A-alfa-only', 'issuer-restores-alfa-policy',
    'issuer-inactivates-alfa-only', 'issuer-restores-active-alfa-policy',
    'short-lived-X-proof-bound', 'validator-clock-reaches-expiry',
    'expired-proof-rejects-both-directions', 'external-expired-proof-rejected', 'delegate-expired-owner-rejected',
    'valid-X-proof-bindings-restored', 'delegate-approval-revoked',
    ...SCHEMA_VALIDITY_STAGES,
    ...SAS_ADVERSARIAL_STAGES,
    ...MISSING_BINDING_STAGES,
  ] as const),
} as const)

export const FAULT_ACCEPTANCE_MANIFEST = Object.freeze({
  version: 1,
  stageIds: Object.freeze([
    'fault-localnet-preconditions', 'rpc-account-timeout', 'rpc-unavailable-incident',
    'rpc-stale-read-keeps-open', 'confirmation-timeout-keeps-open',
    'read-only-recheck-recovers-signature', 'fresh-complete-readback-resolves',
  ] as const),
} as const)
