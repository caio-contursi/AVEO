use anchor_lang::prelude::*;

/// Official Token-2022 program. Source: SPL / `docs/interface-v2.md`.
pub const TOKEN_2022_PROGRAM_ID: Pubkey =
    pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/// Official Solana Attestation Service program.
/// Source: https://github.com/solana-foundation/solana-attestation-service
/// `program/src/lib.rs` (`declare_id!`) and https://attest.solana.com/docs/guides/rust/how-to-create-digital-credentials
pub const SAS_PROGRAM_ID: Pubkey = pubkey!("22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG");

pub const POLICY_SEED: &[u8] = b"policy";
pub const BINDING_SEED: &[u8] = b"binding";
/// Official Transfer Hook ExtraAccountMetaList seed.
/// Source: https://solana.com/docs/tokens/extensions/transfer-hook
pub const EXTRA_ACCOUNT_METAS_SEED: &[u8] = b"extra-account-metas";

pub const MAX_PAIRS: usize = 2;
pub const LAYOUT_VERSION: u8 = 2;
pub const PAYLOAD_VERSION: u8 = 2;

/// Official SAS account discriminators.
/// Source: `program/src/state/discriminator.rs` in solana-attestation-service.
pub const SAS_CREDENTIAL_DISCRIMINATOR: u8 = 0;
pub const SAS_SCHEMA_DISCRIMINATOR: u8 = 1;
pub const SAS_ATTESTATION_DISCRIMINATOR: u8 = 2;

/// Official SAS PDA seeds.
/// Source: https://attest.solana.com/docs/helpers and SAS `program/src/constants.rs`.
pub const SAS_CREDENTIAL_SEED: &[u8] = b"credential";
pub const SAS_SCHEMA_SEED: &[u8] = b"schema";
pub const SAS_ATTESTATION_SEED: &[u8] = b"attestation";

/// Official SPL Token account owner field offset (mint 0..32, owner 32..64).
pub const TOKEN_ACCOUNT_OWNER_OFFSET: u8 = 32;
pub const TOKEN_ACCOUNT_MINT_OFFSET: usize = 0;

/// Pinned SAS schema layout for `aveo-eligibility-v2`:
/// U8, VecU8, VecU8, Bool, Bool.
/// Type IDs from https://attest.solana.com/docs/schemas
pub const AVEO_ELIGIBILITY_V2_LAYOUT: [u8; 5] = [0, 13, 13, 10, 10];
pub const AVEO_ELIGIBILITY_V2_DATA_LEN: usize = 75;

/// Execute account indices (official Transfer Hook order, then Aveo extras).
pub const EXECUTE_IX_SOURCE: usize = 0;
pub const EXECUTE_IX_MINT: usize = 1;
pub const EXECUTE_IX_DESTINATION: usize = 2;
pub const EXECUTE_IX_AUTHORITY: usize = 3;
pub const EXECUTE_IX_EXTRA_METAS: usize = 4;
pub const EXECUTE_IX_POLICY: usize = 5;
pub const EXECUTE_IX_SRC_BINDING: usize = 6;
pub const EXECUTE_IX_DST_BINDING: usize = 7;
pub const EXECUTE_IX_SRC_CREDENTIAL: usize = 8;
pub const EXECUTE_IX_SRC_SCHEMA: usize = 9;
pub const EXECUTE_IX_SRC_ATTESTATION: usize = 10;
pub const EXECUTE_IX_DST_CREDENTIAL: usize = 11;
pub const EXECUTE_IX_DST_SCHEMA: usize = 12;
pub const EXECUTE_IX_DST_ATTESTATION: usize = 13;
pub const EXECUTE_ACCOUNT_COUNT: usize = 14;
pub const EXTRA_META_COUNT: usize = 9;

/// EligibilityBinding offsets including the 8-byte Anchor discriminator.
/// Generated from the fixed Aveo layout and asserted in unit tests.
pub const BINDING_OFFSET_VERSION: usize = 8;
pub const BINDING_OFFSET_MINT: usize = 9;
pub const BINDING_OFFSET_SUBJECT: usize = 41;
pub const BINDING_OFFSET_CREDENTIAL: usize = 73;
pub const BINDING_OFFSET_SCHEMA: usize = 105;
pub const BINDING_OFFSET_ATTESTATION: usize = 137;
pub const BINDING_OFFSET_BUMP: usize = 169;
