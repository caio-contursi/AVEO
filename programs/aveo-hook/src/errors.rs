use anchor_lang::prelude::*;

/// Stable on-chain errors. Order is part of the aveo-v2 contract (6000–6014).
/// Do not reorder. New codes are appended: 6015 is `UnauthorizedIssuer`.
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
    /// Signer is not the issuer stored on the policy. Appended so 6000–6014 stay stable.
    UnauthorizedIssuer,
}
