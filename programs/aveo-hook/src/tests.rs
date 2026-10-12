use crate::constants::*;
use crate::eligibility::{
    load_binding, load_policy, require_live_eligibility, require_presented_proof,
};
use crate::errors::AveoError;
use crate::extra_metas::{
    extra_account_meta_list_size, extra_account_metas, init_extra_account_meta_list,
};
use crate::payload::EligibilityPayload;
use crate::sas::{load_and_check_sas, sas_name_seed, SasAttestation, SasCredential, SasSchema};
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

// Own the backing storage so AccountInfo borrows stay local to each validation.
struct TestAccount {
    key: Pubkey,
    owner: Pubkey,
    lamports: u64,
    data: Vec<u8>,
}

impl TestAccount {
    fn new(key: Pubkey, owner: Pubkey, data: Vec<u8>) -> Self {
        Self {
            key,
            owner,
            lamports: 1,
            data,
        }
    }

    fn info(&mut self) -> AccountInfo<'_> {
        AccountInfo::new(
            &self.key,
            false,
            false,
            &mut self.lamports,
            &mut self.data,
            &self.owner,
            false,
            0,
        )
    }
}

fn assert_aveo_error<T>(result: Result<T>, expected: AveoError) {
    match result {
        Err(anchor_lang::error::Error::AnchorError(error)) => {
            assert_eq!(error.error_code_number, 6000 + expected as u32);
        }
        Err(error) => panic!("Expected an Aveo error, got {error}"),
        Ok(_) => panic!("Expected validation to reject the account"),
    }
}

fn serialized_account<T: AccountSerialize>(key: Pubkey, value: &T) -> TestAccount {
    let mut data = Vec::new();
    value.try_serialize(&mut data).unwrap();
    TestAccount::new(key, crate::ID, data)
}

struct ProofFixture {
    credential: SasCredential,
    schema: SasSchema,
    attestation: SasAttestation,
    subject: Pubkey,
    policy: IssuerPolicy,
    clock: Clock,
}

impl ProofFixture {
    fn new() -> Self {
        let subject = test_pubkey(8);
        let credential = SasCredential {
            authority: test_pubkey(1),
            name: b"live-verifier".to_vec(),
            authorized_signers: vec![test_pubkey(2)],
        };
        let schema = SasSchema {
            credential: credential.derive_address(),
            name: b"aveo-eligibility-v2".to_vec(),
            layout: AVEO_ELIGIBILITY_V2_LAYOUT.to_vec(),
            is_paused: false,
            version: 1,
        };
        let attestation = SasAttestation {
            nonce: test_pubkey(3),
            credential: credential.derive_address(),
            schema: schema.derive_address(),
            data: EligibilityPayload {
                version: PAYLOAD_VERSION,
                subject_wallet: subject,
                proof_domain: [4; 32],
                kyc_pass: true,
                accredited_pass: true,
            }
            .encode()
            .unwrap(),
            signer: test_pubkey(2),
            expiry: 1_700_000_001,
            // A SAS token account is deliberately distinct from the subject.
            token_account: test_pubkey(9),
        };
        let empty = ProviderPair {
            credential: Pubkey::default(),
            schema: Pubkey::default(),
        };
        let policy = IssuerPolicy {
            version: LAYOUT_VERSION,
            mint: test_pubkey(10),
            issuer_authority: test_pubkey(11),
            sas_program_id: SAS_PROGRAM_ID,
            proof_domain: [4; 32],
            pair_count: 1,
            pairs: [
                ProviderPair {
                    credential: credential.derive_address(),
                    schema: schema.derive_address(),
                },
                empty,
            ],
            require_kyc: true,
            require_accredited: true,
            active: true,
            policy_version: 1,
            bump: 0,
        };
        Self {
            credential,
            schema,
            attestation,
            subject,
            policy,
            clock: Clock {
                unix_timestamp: 1_700_000_000,
                ..Clock::default()
            },
        }
    }

    fn accounts(&self) -> [TestAccount; 3] {
        let mut credential = vec![SAS_CREDENTIAL_DISCRIMINATOR];
        credential.extend_from_slice(self.credential.authority.as_ref());
        credential.extend(encode_vec_u8(&self.credential.name));
        credential.extend_from_slice(
            &(self.credential.authorized_signers.len() as u32).to_le_bytes(),
        );
        for signer in &self.credential.authorized_signers {
            credential.extend_from_slice(signer.as_ref());
        }

        let mut schema = vec![SAS_SCHEMA_DISCRIMINATOR];
        schema.extend_from_slice(self.schema.credential.as_ref());
        schema.extend(encode_vec_u8(&self.schema.name));
        schema.extend(encode_vec_u8(b"live test"));
        schema.extend(encode_vec_u8(&self.schema.layout));
        schema.extend(encode_vec_u8(&[]));
        schema.push(u8::from(self.schema.is_paused));
        schema.push(self.schema.version);

        let mut attestation = vec![SAS_ATTESTATION_DISCRIMINATOR];
        attestation.extend_from_slice(self.attestation.nonce.as_ref());
        attestation.extend_from_slice(self.attestation.credential.as_ref());
        attestation.extend_from_slice(self.attestation.schema.as_ref());
        attestation.extend(encode_vec_u8(&self.attestation.data));
        attestation.extend_from_slice(self.attestation.signer.as_ref());
        attestation.extend_from_slice(&self.attestation.expiry.to_le_bytes());
        attestation.extend_from_slice(self.attestation.token_account.as_ref());
        [
            TestAccount::new(self.credential.derive_address(), SAS_PROGRAM_ID, credential),
            TestAccount::new(self.schema.derive_address(), SAS_PROGRAM_ID, schema),
            TestAccount::new(
                self.attestation.derive_address(),
                SAS_PROGRAM_ID,
                attestation,
            ),
        ]
    }

    fn validate(
        &self,
        accounts: &mut [TestAccount; 3],
        presented_only: bool,
    ) -> Result<SasAttestation> {
        let [credential, schema, attestation] = accounts;
        let validate = if presented_only {
            require_presented_proof
        } else {
            require_live_eligibility
        };
        validate(
            &self.policy,
            &self.subject,
            &credential.info(),
            &schema.info(),
            &attestation.info(),
            &self.credential.derive_address(),
            &self.schema.derive_address(),
            &self.attestation.derive_address(),
            &self.clock,
        )
    }
}

fn check_sas(
    accounts: &mut [TestAccount; 3],
    expected: [Pubkey; 3],
) -> Result<(SasCredential, SasSchema, SasAttestation)> {
    let [credential, schema, attestation] = accounts;
    load_and_check_sas(
        &credential.info(),
        &schema.info(),
        &attestation.info(),
        &expected[0],
        &expected[1],
        &expected[2],
    )
}

#[test]
fn live_eligibility_uses_payload_subject_not_sas_token_account() {
    let mut fixture = ProofFixture::new();
    let accepted = fixture.validate(&mut fixture.accounts(), false).unwrap();
    assert_ne!(accepted.token_account, fixture.subject);
    fixture.subject = accepted.token_account;
    assert_aveo_error(
        fixture.validate(&mut fixture.accounts(), false),
        AveoError::SubjectMismatch,
    );
}

#[test]
fn live_eligibility_rechecks_expiry_at_the_transfer_clock() {
    let mut fixture = ProofFixture::new();
    let mut accounts = fixture.accounts();
    fixture.validate(&mut accounts, true).unwrap();
    fixture.validate(&mut accounts, false).unwrap();
    // Reuse identical proof accounts: reaching the expiry boundary invalidates them.
    for timestamp in [fixture.attestation.expiry, fixture.attestation.expiry + 1] {
        fixture.clock.unix_timestamp = timestamp;
        for presented_only in [true, false] {
            assert_aveo_error(
                fixture.validate(&mut accounts, presented_only),
                AveoError::AttestationExpired,
            );
        }
    }
}

#[test]
fn live_eligibility_rejects_closed_or_missing_sas_accounts() {
    let fixture = ProofFixture::new();
    for index in 0..3 {
        for empty_data in [false, true] {
            let mut accounts = fixture.accounts();
            fixture.validate(&mut accounts, false).unwrap();
            if empty_data {
                accounts[index].data.clear();
            } else {
                accounts[index].owner = System::id();
                accounts[index].lamports = 0;
            }
            assert_aveo_error(
                fixture.validate(&mut accounts, false),
                AveoError::AttestationMissingOrClosed,
            );
        }
    }
}

#[test]
fn presented_proof_does_not_bypass_live_provider_pair_policy() {
    for changed_field in 0..3 {
        let mut fixture = ProofFixture::new();
        let mut accounts = fixture.accounts();
        fixture.validate(&mut accounts, false).unwrap();
        match changed_field {
            0 => fixture.policy.pairs[0].credential = test_pubkey(20),
            1 => fixture.policy.pairs[0].schema = test_pubkey(21),
            _ => fixture.policy.pair_count = 0,
        }
        fixture.validate(&mut accounts, true).unwrap();
        assert_aveo_error(
            fixture.validate(&mut accounts, false),
            AveoError::ProviderPairNotAllowed,
        );
    }
}

#[test]
fn live_eligibility_enforces_each_required_fact_independently() {
    for (kyc_pass, accredited_pass) in [(false, true), (true, false), (false, false)] {
        let mut fixture = ProofFixture::new();
        let mut payload = fixture.attestation.payload().unwrap();
        payload.kyc_pass = kyc_pass;
        payload.accredited_pass = accredited_pass;
        fixture.attestation.data = payload.encode().unwrap();
        let mut accounts = fixture.accounts();
        fixture.validate(&mut accounts, true).unwrap();
        assert_aveo_error(
            fixture.validate(&mut accounts, false),
            AveoError::RequiredFactMissing,
        );
        fixture.policy.require_kyc = kyc_pass;
        fixture.policy.require_accredited = accredited_pass;
        fixture.validate(&mut accounts, false).unwrap();
    }
}

#[test]
fn presented_and_live_proofs_reject_subject_and_domain_mismatch() {
    for wrong_subject in [false, true] {
        let mut fixture = ProofFixture::new();
        let mut payload = fixture.attestation.payload().unwrap();
        if wrong_subject {
            payload.subject_wallet = test_pubkey(20);
        } else {
            payload.proof_domain = [20; 32];
        }
        fixture.attestation.data = payload.encode().unwrap();
        for presented_only in [true, false] {
            assert_aveo_error(
                fixture.validate(&mut fixture.accounts(), presented_only),
                if wrong_subject {
                    AveoError::SubjectMismatch
                } else {
                    AveoError::ProofDomainMismatch
                },
            );
        }
    }
}

#[test]
fn credential_rejects_signer_counts_larger_than_remaining_bytes() {
    let fixture = ProofFixture::new();
    let mut prefix = vec![SAS_CREDENTIAL_DISCRIMINATOR];
    prefix.extend_from_slice(fixture.credential.authority.as_ref());
    prefix.extend(encode_vec_u8(&fixture.credential.name));
    for count in [1u32, 2, u32::MAX] {
        let mut bytes = prefix.clone();
        bytes.extend_from_slice(&count.to_le_bytes());
        if count == 2 {
            bytes.extend_from_slice(test_pubkey(2).as_ref());
        }
        assert_aveo_error(
            SasCredential::try_from_bytes(&bytes),
            AveoError::InvalidSasOwnerOrData,
        );
    }
    let mut bytes = prefix;
    bytes.extend_from_slice(&0u32.to_le_bytes());
    assert!(SasCredential::try_from_bytes(&bytes)
        .unwrap()
        .authorized_signers
        .is_empty());
}

#[test]
fn schema_accepts_only_canonical_pause_boolean_bytes() {
    let fixture = ProofFixture::new();
    let accounts = fixture.accounts();
    let mut bytes = accounts[1].data.clone();
    let pause_offset = bytes.len() - 2;
    for paused in 0u8..=u8::MAX {
        bytes[pause_offset] = paused;
        let parsed = SasSchema::try_from_bytes(&bytes);
        if paused <= 1 {
            assert_eq!(parsed.unwrap().is_paused, paused == 1);
        } else {
            assert_aveo_error(parsed, AveoError::InvalidSasOwnerOrData);
        }
    }
}

#[test]
fn live_eligibility_rechecks_schema_pause_layout_and_signer_revocation() {
    for mutation in 0..3 {
        let mut fixture = ProofFixture::new();
        fixture.validate(&mut fixture.accounts(), false).unwrap();
        match mutation {
            0 => fixture.schema.is_paused = true,
            1 => fixture.schema.layout[0] = 1,
            _ => fixture.credential.authorized_signers.clear(),
        }
        assert_aveo_error(
            fixture.validate(&mut fixture.accounts(), false),
            if mutation == 2 {
                AveoError::UnauthorizedAttestationSigner
            } else {
                AveoError::SchemaMismatchOrPaused
            },
        );
    }
}

#[test]
fn sas_validation_rejects_wrong_owner_discriminator_and_truncation() {
    let fixture = ProofFixture::new();
    for index in 0..3 {
        for mutation in 0..3 {
            let mut accounts = fixture.accounts();
            match mutation {
                0 => accounts[index].owner = crate::ID,
                1 => accounts[index].data[0] = 255,
                _ => {
                    accounts[index].data.pop();
                }
            }
            assert_aveo_error(
                fixture.validate(&mut accounts, false),
                AveoError::InvalidSasOwnerOrData,
            );
        }
    }
}

#[test]
fn sas_validation_rejects_substituted_accounts_and_forged_pdas() {
    let fixture = ProofFixture::new();
    for index in 0..3 {
        let mut accounts = fixture.accounts();
        accounts[index].key = test_pubkey(20);
        assert_aveo_error(
            fixture.validate(&mut accounts, false),
            if index == 2 {
                AveoError::AttestationMissingOrClosed
            } else {
                AveoError::InvalidSasOwnerOrData
            },
        );
        // Even accepting the caller's substituted key must not bypass PDA derivation.
        let expected = [accounts[0].key, accounts[1].key, accounts[2].key];
        assert_aveo_error(
            check_sas(&mut accounts, expected),
            AveoError::InvalidSasOwnerOrData,
        );
    }
}

#[test]
fn sas_validation_rejects_cross_linked_accounts_even_at_valid_pdas() {
    for mutation in 0..3 {
        let mut fixture = ProofFixture::new();
        match mutation {
            0 => fixture.schema.credential = test_pubkey(20),
            1 => fixture.attestation.credential = test_pubkey(20),
            _ => fixture.attestation.schema = test_pubkey(20),
        }
        // Re-derive addresses from the mutated records to reach the link checks.
        let mut accounts = fixture.accounts();
        let expected = [accounts[0].key, accounts[1].key, accounts[2].key];
        assert_aveo_error(
            check_sas(&mut accounts, expected),
            if mutation == 1 {
                AveoError::InvalidSasOwnerOrData
            } else {
                AveoError::SchemaMismatchOrPaused
            },
        );
    }
}

#[test]
fn policy_loader_rejects_inactive_spoofed_and_incompatible_accounts() {
    for mutation in 0..9 {
        let mut fixture = ProofFixture::new();
        let mint = fixture.policy.mint;
        let key = Pubkey::find_program_address(&[POLICY_SEED, mint.as_ref()], &crate::ID).0;
        let mut valid = serialized_account(key, &fixture.policy);
        load_policy(&valid.info(), &mint).unwrap();
        match mutation {
            0 => fixture.policy.active = false,
            1 => fixture.policy.version = LAYOUT_VERSION + 1,
            2 => fixture.policy.mint = test_pubkey(20),
            3 => fixture.policy.sas_program_id = crate::ID,
            _ => {}
        }
        let mut account = serialized_account(key, &fixture.policy);
        match mutation {
            4 => account.owner = SAS_PROGRAM_ID,
            5 => account.key = test_pubkey(20),
            6 => account.data.clear(),
            7 => account.data[0] ^= 255,
            8 => {
                account.data.pop();
            }
            _ => {}
        }
        assert_aveo_error(
            load_policy(&account.info(), &mint),
            match mutation {
                2 => AveoError::MintMismatch,
                3 => AveoError::InvalidSasOwnerOrData,
                _ => AveoError::PolicyMissingOrInactive,
            },
        );
    }
}

#[test]
fn binding_loader_rejects_spoofed_subject_mint_and_layout() {
    let fixture = ProofFixture::new();
    let mint = fixture.policy.mint;
    let subject = fixture.subject;
    let (key, bump) = Pubkey::find_program_address(
        &[BINDING_SEED, mint.as_ref(), subject.as_ref()],
        &crate::ID,
    );
    for mutation in 0..8 {
        let mut binding = EligibilityBinding {
            version: LAYOUT_VERSION,
            mint,
            subject_wallet: subject,
            credential: fixture.credential.derive_address(),
            schema: fixture.schema.derive_address(),
            attestation: fixture.attestation.derive_address(),
            bump,
        };
        let mut valid = serialized_account(key, &binding);
        let loaded = load_binding(&valid.info(), &mint, &subject).unwrap();
        assert_eq!(loaded.attestation, fixture.attestation.derive_address());
        match mutation {
            0 => binding.subject_wallet = test_pubkey(20),
            1 => binding.mint = test_pubkey(20),
            2 => binding.version = LAYOUT_VERSION + 1,
            _ => {}
        }
        let mut account = serialized_account(key, &binding);
        match mutation {
            3 => account.owner = SAS_PROGRAM_ID,
            4 => account.key = test_pubkey(20),
            5 => account.data.clear(),
            6 => account.data[0] ^= 255,
            7 => {
                account.data.pop();
            }
            _ => {}
        }
        assert_aveo_error(
            load_binding(&account.info(), &mint, &subject),
            if mutation < 2 {
                AveoError::BindingSubjectMismatch
            } else {
                AveoError::BindingMissing
            },
        );
    }
}
