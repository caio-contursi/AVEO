use crate::constants::{LAYOUT_VERSION, MAX_PAIRS};
use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq)]
pub struct ProviderPair {
    pub credential: Pubkey,
    pub schema: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PolicyArgs {
    pub proof_domain: [u8; 32],
    pub pairs: Vec<ProviderPair>,
    pub require_kyc: bool,
    pub require_accredited: bool,
    pub active: bool,
}

#[account]
#[derive(InitSpace)]
pub struct IssuerPolicy {
    pub version: u8,
    pub mint: Pubkey,
    pub issuer_authority: Pubkey,
    /// Fixed at init from the verified SAS program ID; never taken from the caller.
    pub sas_program_id: Pubkey,
    pub proof_domain: [u8; 32],
    pub pair_count: u8,
    pub pairs: [ProviderPair; MAX_PAIRS],
    pub require_kyc: bool,
    pub require_accredited: bool,
    pub active: bool,
    pub policy_version: u64,
    pub bump: u8,
}

impl IssuerPolicy {
    pub fn apply(&mut self, args: PolicyArgs) -> Result<()> {
        require!(
            args.pairs.len() <= MAX_PAIRS,
            crate::errors::AveoError::ProviderPairNotAllowed
        );
        self.proof_domain = args.proof_domain;
        self.pair_count = args.pairs.len() as u8;
        let empty = ProviderPair {
            credential: Pubkey::default(),
            schema: Pubkey::default(),
        };
        self.pairs = [empty; MAX_PAIRS];
        for (slot, pair) in self.pairs.iter_mut().zip(args.pairs) {
            *slot = pair;
        }
        self.require_kyc = args.require_kyc;
        self.require_accredited = args.require_accredited;
        self.active = args.active;
        Ok(())
    }

    pub fn allowed_pairs(&self) -> &[ProviderPair] {
        &self.pairs[..self.pair_count as usize]
    }

    pub fn allows(&self, credential: &Pubkey, schema: &Pubkey) -> bool {
        self.allowed_pairs()
            .iter()
            .any(|p| p.credential == *credential && p.schema == *schema)
    }
}

#[account]
#[derive(InitSpace)]
pub struct EligibilityBinding {
    pub version: u8,
    pub mint: Pubkey,
    pub subject_wallet: Pubkey,
    pub credential: Pubkey,
    pub schema: Pubkey,
    pub attestation: Pubkey,
    pub bump: u8,
}

impl EligibilityBinding {
    pub fn write(
        &mut self,
        mint: Pubkey,
        subject_wallet: Pubkey,
        credential: Pubkey,
        schema: Pubkey,
        attestation: Pubkey,
        bump: u8,
    ) {
        self.version = LAYOUT_VERSION;
        self.mint = mint;
        self.subject_wallet = subject_wallet;
        self.credential = credential;
        self.schema = schema;
        self.attestation = attestation;
        self.bump = bump;
    }
}
