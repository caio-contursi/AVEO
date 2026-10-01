use crate::constants::{BINDING_SEED, LAYOUT_VERSION, POLICY_SEED, SAS_PROGRAM_ID};
use crate::errors::AveoError;
use crate::sas::{load_and_check_sas, SasAttestation};
use crate::state::{EligibilityBinding, IssuerPolicy};
use anchor_lang::prelude::*;

pub fn load_policy(info: &AccountInfo, mint: &Pubkey) -> Result<IssuerPolicy> {
    if info.data_is_empty() || info.owner != &crate::ID {
        return err!(AveoError::PolicyMissingOrInactive);
    }
    let (expected, _) =
        Pubkey::find_program_address(&[POLICY_SEED, mint.as_ref()], &crate::ID);
    require_keys_eq!(*info.key, expected, AveoError::PolicyMissingOrInactive);

    let mut data: &[u8] = &info.try_borrow_data()?;
    let policy = IssuerPolicy::try_deserialize(&mut data)
        .map_err(|_| error!(AveoError::PolicyMissingOrInactive))?;
    require_keys_eq!(policy.mint, *mint, AveoError::MintMismatch);
    require!(policy.active, AveoError::PolicyMissingOrInactive);
    require_keys_eq!(
        policy.sas_program_id,
        SAS_PROGRAM_ID,
        AveoError::InvalidSasOwnerOrData
    );
    require!(
        policy.version == LAYOUT_VERSION,
        AveoError::PolicyMissingOrInactive
    );
    Ok(policy)
}

pub fn load_binding(
    info: &AccountInfo,
    mint: &Pubkey,
    subject: &Pubkey,
) -> Result<EligibilityBinding> {
    if info.data_is_empty() || info.owner != &crate::ID {
        return err!(AveoError::BindingMissing);
    }
    let (expected, _) = Pubkey::find_program_address(
        &[BINDING_SEED, mint.as_ref(), subject.as_ref()],
        &crate::ID,
    );
    require_keys_eq!(*info.key, expected, AveoError::BindingMissing);

    let mut data: &[u8] = &info.try_borrow_data()?;
    let binding = EligibilityBinding::try_deserialize(&mut data)
        .map_err(|_| error!(AveoError::BindingMissing))?;
    require!(binding.version == LAYOUT_VERSION, AveoError::BindingMissing);
    require_keys_eq!(binding.mint, *mint, AveoError::BindingSubjectMismatch);
    require_keys_eq!(
        binding.subject_wallet,
        *subject,
        AveoError::BindingSubjectMismatch
    );
    Ok(binding)
}

pub fn require_live_eligibility(
    policy: &IssuerPolicy,
    subject: &Pubkey,
    credential_info: &AccountInfo,
    schema_info: &AccountInfo,
    attestation_info: &AccountInfo,
    expected_credential: &Pubkey,
    expected_schema: &Pubkey,
    expected_attestation: &Pubkey,
    clock: &Clock,
) -> Result<SasAttestation> {
    require!(
        policy.allows(expected_credential, expected_schema),
        AveoError::ProviderPairNotAllowed
    );

    let (_credential, _schema, attestation) = load_and_check_sas(
        credential_info,
        schema_info,
        attestation_info,
        expected_credential,
        expected_schema,
        expected_attestation,
    )?;

    require!(
        attestation.expiry > clock.unix_timestamp,
        AveoError::AttestationExpired
    );

    let payload = attestation.payload()?;
    require_keys_eq!(
        payload.subject_wallet,
        *subject,
        AveoError::SubjectMismatch
    );
    require!(
        payload.proof_domain == policy.proof_domain,
        AveoError::ProofDomainMismatch
    );
    if policy.require_kyc && !payload.kyc_pass {
        return err!(AveoError::RequiredFactMissing);
    }
    if policy.require_accredited && !payload.accredited_pass {
        return err!(AveoError::RequiredFactMissing);
    }
    Ok(attestation)
}
