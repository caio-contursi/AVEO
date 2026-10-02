use crate::constants::*;
use crate::errors::AveoError;
use crate::extra_metas::{
    extra_account_meta_list_size, extra_account_metas, init_extra_account_meta_list,
};
use crate::payload::EligibilityPayload;
use crate::sas::{sas_name_seed, SasAttestation, SasCredential, SasSchema};
use crate::state::{EligibilityBinding, IssuerPolicy, ProviderPair};
use anchor_lang::prelude::*;
use anchor_lang::{AccountDeserialize, AccountSerialize, Discriminator};

fn test_pubkey(seed: u8) -> Pubkey {
    Pubkey::new_from_array([seed; 32])
}

fn encode_vec_u8(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(bytes);
    out
}

#[test]
fn error_codes_are_stable_6000_through_6014_and_append_6015() {
    let names = [
        "NotTransferContext",
        "PolicyMissingOrInactive",
        "MintMismatch",
        "BindingMissing",
        "BindingSubjectMismatch",
        "ProviderPairNotAllowed",
        "SchemaMismatchOrPaused",
        "AttestationMissingOrClosed",
        "InvalidSasOwnerOrData",
        "UnauthorizedAttestationSigner",
        "SubjectMismatch",
        "ProofDomainMismatch",
        "RequiredFactMissing",
        "AttestationExpired",
        "MissingExtraAccounts",
        "UnauthorizedIssuer",
    ];
    assert_eq!(names.len(), 16);
    assert_eq!(AveoError::NotTransferContext as u32, 0);
    assert_eq!(AveoError::MissingExtraAccounts as u32, 14);
    assert_eq!(AveoError::UnauthorizedIssuer as u32, 15);
}

#[test]
fn binding_offsets_match_serialized_layout() {
    let binding = EligibilityBinding {
        version: LAYOUT_VERSION,
        mint: test_pubkey(1),
        subject_wallet: test_pubkey(2),
        credential: test_pubkey(3),
        schema: test_pubkey(4),
        attestation: test_pubkey(5),
        bump: 9,
    };
    let mut data = Vec::new();
    binding.try_serialize(&mut data).unwrap();

    assert_eq!(data.len(), 8 + EligibilityBinding::INIT_SPACE);
    assert_eq!(&data[..8], EligibilityBinding::DISCRIMINATOR);
    assert_eq!(data[BINDING_OFFSET_VERSION], LAYOUT_VERSION);
    assert_eq!(&data[BINDING_OFFSET_MINT..BINDING_OFFSET_SUBJECT], binding.mint.as_ref());
    assert_eq!(
        &data[BINDING_OFFSET_SUBJECT..BINDING_OFFSET_CREDENTIAL],
        binding.subject_wallet.as_ref()
    );
    assert_eq!(
        &data[BINDING_OFFSET_CREDENTIAL..BINDING_OFFSET_SCHEMA],
        binding.credential.as_ref()
    );
    assert_eq!(
        &data[BINDING_OFFSET_SCHEMA..BINDING_OFFSET_ATTESTATION],
        binding.schema.as_ref()
    );
    assert_eq!(
        &data[BINDING_OFFSET_ATTESTATION..BINDING_OFFSET_BUMP],
        binding.attestation.as_ref()
    );
    assert_eq!(data[BINDING_OFFSET_BUMP], 9);
    assert!(BINDING_OFFSET_CREDENTIAL <= u8::MAX as usize);
    assert!(BINDING_OFFSET_ATTESTATION <= u8::MAX as usize);
}

#[test]
fn policy_allows_only_configured_pairs() {
    let a = ProviderPair {
        credential: test_pubkey(10),
        schema: test_pubkey(11),
    };
    let b = ProviderPair {
        credential: test_pubkey(12),
        schema: test_pubkey(13),
    };
    let mut policy = IssuerPolicy {
        version: LAYOUT_VERSION,
        mint: test_pubkey(1),
        issuer_authority: test_pubkey(2),
        sas_program_id: SAS_PROGRAM_ID,
        proof_domain: [7u8; 32],
        pair_count: 2,
        pairs: [a, b],
        require_kyc: true,
        require_accredited: false,
        active: true,
        policy_version: 1,
        bump: 1,
    };
    assert!(policy.allows(&a.credential, &a.schema));
    assert!(policy.allows(&b.credential, &b.schema));
    assert!(!policy.allows(&a.credential, &b.schema));
    policy.pair_count = 1;
    assert!(!policy.allows(&b.credential, &b.schema));
}

#[test]
fn payload_round_trip_and_exact_layout() {
    let payload = EligibilityPayload {
        version: PAYLOAD_VERSION,
        subject_wallet: test_pubkey(8),
        proof_domain: [3u8; 32],
        kyc_pass: true,
        accredited_pass: false,
    };
    let encoded = payload.encode().unwrap();
    assert_eq!(encoded.len(), AVEO_ELIGIBILITY_V2_DATA_LEN);
    assert_eq!(encoded[0], 2);
    assert_eq!(&encoded[1..5], &32u32.to_le_bytes());
    assert_eq!(EligibilityPayload::decode(&encoded).unwrap(), payload);
}

#[test]
fn payload_rejects_trailing_wrong_version_and_lengths() {
    let payload = EligibilityPayload {
        version: PAYLOAD_VERSION,
        subject_wallet: test_pubkey(8),
        proof_domain: [3u8; 32],
        kyc_pass: true,
        accredited_pass: true,
    };
    let mut encoded = payload.encode().unwrap();
    encoded.push(0);
    assert!(EligibilityPayload::decode(&encoded).is_err());

    let mut short = payload.encode().unwrap();
    short[0] = 1;
    assert!(EligibilityPayload::decode(&short).is_err());

    let mut bad_len = payload.encode().unwrap();
    bad_len[1..5].copy_from_slice(&31u32.to_le_bytes());
    assert!(EligibilityPayload::decode(&bad_len).is_err());

    let mut bad_bool = payload.encode().unwrap();
    bad_bool[73] = 2;
    assert!(EligibilityPayload::decode(&bad_bool).is_err());
}

#[test]
fn sas_parsers_follow_official_layouts() {
    let authority = test_pubkey(1);
    let signer = test_pubkey(2);
    let name = b"verifier-a".to_vec();

    let mut cred = vec![SAS_CREDENTIAL_DISCRIMINATOR];
    cred.extend_from_slice(authority.as_ref());
    cred.extend(encode_vec_u8(&name));
    cred.extend_from_slice(&1u32.to_le_bytes());
    cred.extend_from_slice(signer.as_ref());
    let credential = SasCredential::try_from_bytes(&cred).unwrap();
    assert_eq!(credential.authority, authority);
    assert!(credential.is_authorized_signer(&signer));
    assert!(!credential.is_authorized_signer(&test_pubkey(9)));
    assert_eq!(
        credential.derive_address(),
        Pubkey::find_program_address(
            &[SAS_CREDENTIAL_SEED, authority.as_ref(), name.as_ref()],
            &SAS_PROGRAM_ID
        )
        .0
    );

    let cred_pda = credential.derive_address();
    let schema_name = b"aveo-eligibility-v2".to_vec();
    let mut schema_bytes = vec![SAS_SCHEMA_DISCRIMINATOR];
    schema_bytes.extend_from_slice(cred_pda.as_ref());
    schema_bytes.extend(encode_vec_u8(&schema_name));
    schema_bytes.extend(encode_vec_u8(b"demo"));
    schema_bytes.extend(encode_vec_u8(&AVEO_ELIGIBILITY_V2_LAYOUT));
    schema_bytes.extend(encode_vec_u8(&[]));
    schema_bytes.push(0);
    schema_bytes.push(1);
    let schema = SasSchema::try_from_bytes(&schema_bytes).unwrap();
    assert!(schema.is_aveo_eligibility_v2());
    assert!(!schema.is_paused);
    assert_eq!(schema.credential, cred_pda);

    let payload = EligibilityPayload {
        version: PAYLOAD_VERSION,
        subject_wallet: test_pubkey(8),
        proof_domain: [4u8; 32],
        kyc_pass: true,
        accredited_pass: true,
    }
    .encode()
    .unwrap();
    let nonce = test_pubkey(8);
    let schema_pda = schema.derive_address();
    let mut att = vec![SAS_ATTESTATION_DISCRIMINATOR];
    att.extend_from_slice(nonce.as_ref());
    att.extend_from_slice(cred_pda.as_ref());
    att.extend_from_slice(schema_pda.as_ref());
    att.extend(encode_vec_u8(&payload));
    att.extend_from_slice(signer.as_ref());
    att.extend_from_slice(&1_700_000_000i64.to_le_bytes());
    att.extend_from_slice(Pubkey::default().as_ref());
    let attestation = SasAttestation::try_from_bytes(&att).unwrap();
    assert_eq!(attestation.expiry, 1_700_000_000);
    assert_eq!(attestation.payload().unwrap().subject_wallet, test_pubkey(8));
    assert_eq!(
        attestation.derive_address(),
        Pubkey::find_program_address(
            &[
                SAS_ATTESTATION_SEED,
                cred_pda.as_ref(),
                schema_pda.as_ref(),
                nonce.as_ref()
            ],
            &SAS_PROGRAM_ID
        )
        .0
    );
}

#[test]
fn sas_name_seed_uses_the_first_32_bytes_like_sas_lib() {
    let short = b"verifier-a";
    assert_eq!(sas_name_seed(short), short);

    let long = b"verifier-name-that-is-definitely-longer-than-32-bytes";
    assert!(long.len() > 32);
    assert_eq!(sas_name_seed(long), &long[..32]);

    let authority = test_pubkey(1);
    let mut cred = vec![SAS_CREDENTIAL_DISCRIMINATOR];
    cred.extend_from_slice(authority.as_ref());
    cred.extend(encode_vec_u8(long));
    cred.extend_from_slice(&0u32.to_le_bytes());
    let credential = SasCredential::try_from_bytes(&cred).unwrap();
    assert_eq!(credential.name, long);
    assert_eq!(
        credential.derive_address(),
        Pubkey::find_program_address(
            &[SAS_CREDENTIAL_SEED, authority.as_ref(), &long[..32]],
            &SAS_PROGRAM_ID
        )
        .0
    );

    let mut schema_bytes = vec![SAS_SCHEMA_DISCRIMINATOR];
    schema_bytes.extend_from_slice(credential.derive_address().as_ref());
    schema_bytes.extend(encode_vec_u8(long));
    schema_bytes.extend(encode_vec_u8(b"demo"));
    schema_bytes.extend(encode_vec_u8(&AVEO_ELIGIBILITY_V2_LAYOUT));
    schema_bytes.extend(encode_vec_u8(&[]));
    schema_bytes.push(0);
    schema_bytes.push(1);
    let schema = SasSchema::try_from_bytes(&schema_bytes).unwrap();
    assert_eq!(
        schema.derive_address(),
        Pubkey::find_program_address(
            &[
                SAS_SCHEMA_SEED,
                schema.credential.as_ref(),
                &long[..32],
                &[schema.version],
            ],
            &SAS_PROGRAM_ID
        )
        .0
    );
}

#[test]
fn extra_metas_are_fixed_count_and_fit_tlv() {
    let metas = extra_account_metas().unwrap();
    assert_eq!(metas.len(), EXTRA_META_COUNT);
    let size = extra_account_meta_list_size().unwrap();
    assert!(size > EXTRA_META_COUNT * 35);
    let mut buf = vec![0u8; size];
    init_extra_account_meta_list(&mut buf).unwrap();
    assert!(buf.iter().any(|b| *b != 0));
}

#[test]
fn official_ids_and_seeds_are_the_documented_values() {
    assert_eq!(
        TOKEN_2022_PROGRAM_ID.to_string(),
        "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
    );
    assert_eq!(
        SAS_PROGRAM_ID.to_string(),
        "22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG"
    );
    assert_eq!(POLICY_SEED, b"policy");
    assert_eq!(BINDING_SEED, b"binding");
    assert_eq!(EXTRA_ACCOUNT_METAS_SEED, b"extra-account-metas");
    assert_eq!(AVEO_ELIGIBILITY_V2_LAYOUT, [0, 13, 13, 10, 10]);
}

#[test]
fn issuer_policy_round_trip_keeps_fixed_layout_version() {
    let policy = IssuerPolicy {
        version: LAYOUT_VERSION,
        mint: test_pubkey(1),
        issuer_authority: test_pubkey(2),
        sas_program_id: SAS_PROGRAM_ID,
        proof_domain: [9u8; 32],
        pair_count: 1,
        pairs: [
            ProviderPair {
                credential: test_pubkey(3),
                schema: test_pubkey(4),
            },
            ProviderPair {
                credential: Pubkey::default(),
                schema: Pubkey::default(),
            },
        ],
        require_kyc: true,
        require_accredited: true,
        active: true,
        policy_version: 4,
        bump: 255,
    };
    let mut data = Vec::new();
    policy.try_serialize(&mut data).unwrap();
    let decoded = IssuerPolicy::try_deserialize(&mut data.as_slice()).unwrap();
    assert_eq!(decoded.version, LAYOUT_VERSION);
    assert_eq!(decoded.sas_program_id, SAS_PROGRAM_ID);
    assert_eq!(decoded.policy_version, 4);
    assert!(decoded.allows(&test_pubkey(3), &test_pubkey(4)));
}
