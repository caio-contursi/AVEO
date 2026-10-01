use anchor_lang::prelude::*;

/// Stable on-chain errors. Order is part of the aveo-v2 contract (6000–6014).
/// Do not reorder.
#[error_code]
pub enum AveoError {
    NotTransferContext,
    PolicyMissingOrInactive,
    MintMismatch,
    BindingMissing,
    BindingSubjectMismatch,
    ProviderPairNotAllowed,
    SchemaMismatchOrPaused,
    AttestationMissingOrClosed,
    InvalidSasOwnerOrData,
    UnauthorizedAttestationSigner,
    SubjectMismatch,
    ProofDomainMismatch,
    RequiredFactMissing,
    AttestationExpired,
    MissingExtraAccounts,
}
