use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

declare_id!("ExAoxPmugpGbYTVB31oDTqkkG12PM6neFq4vhM6LJd33");

pub const POLICY_SEED: &[u8] = b"policy";
pub const BINDING_SEED: &[u8] = b"binding";
pub const MAX_PAIRS: usize = 2;
pub const LAYOUT_VERSION: u8 = 2;

#[program]
pub mod aveo_hook {
    use super::*;

    pub fn init_policy(ctx: Context<InitPolicy>, args: PolicyArgs) -> Result<()> {
        require!(args.pairs.len() <= MAX_PAIRS, AveoError::ProviderPairNotAllowed);
        let mint_authority: Option<Pubkey> = ctx.accounts.mint.mint_authority.into();
        require!(
            mint_authority == Some(ctx.accounts.authority.key()),
            AveoError::MintMismatch
        );

        let policy = &mut ctx.accounts.policy;
        policy.version = LAYOUT_VERSION;
        policy.mint = ctx.accounts.mint.key();
        policy.issuer_authority = ctx.accounts.authority.key();
        policy.bump = ctx.bumps.policy;
        policy.policy_version = 1;
        policy.apply(args);
        Ok(())
    }

    pub fn update_policy(ctx: Context<UpdatePolicy>, args: PolicyArgs) -> Result<()> {
        require!(args.pairs.len() <= MAX_PAIRS, AveoError::ProviderPairNotAllowed);
        let policy = &mut ctx.accounts.policy;
        policy.policy_version = policy.policy_version.saturating_add(1);
        policy.apply(args);
        Ok(())
    }

    /// Fails closed until SAS reading and extra-meta resolution pass gate P0.
    pub fn execute(_ctx: Context<Execute>, _amount: u64) -> Result<()> {
        err!(AveoError::MissingExtraAccounts)
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace)]
pub struct ProviderPair {
    pub credential: Pubkey,
    pub schema: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PolicyArgs {
    pub sas_program_id: Pubkey,
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
    fn apply(&mut self, args: PolicyArgs) {
        self.sas_program_id = args.sas_program_id;
        self.proof_domain = args.proof_domain;
        self.pair_count = args.pairs.len() as u8;
        let empty = ProviderPair { credential: Pubkey::default(), schema: Pubkey::default() };
        self.pairs = [empty; MAX_PAIRS];
        for (slot, pair) in self.pairs.iter_mut().zip(args.pairs) {
            *slot = pair;
        }
        self.require_kyc = args.require_kyc;
        self.require_accredited = args.require_accredited;
        self.active = args.active;
    }

    pub fn allows(&self, credential: &Pubkey, schema: &Pubkey) -> bool {
        self.pairs[..self.pair_count as usize]
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

#[derive(Accounts)]
pub struct InitPolicy<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = authority,
        space = 8 + IssuerPolicy::INIT_SPACE,
        seeds = [POLICY_SEED, mint.key().as_ref()],
        bump
    )]
    pub policy: Account<'info, IssuerPolicy>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdatePolicy<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [POLICY_SEED, policy.mint.as_ref()],
        bump = policy.bump,
        has_one = issuer_authority @ AveoError::PolicyMissingOrInactive,
    )]
    pub policy: Account<'info, IssuerPolicy>,
    /// CHECK: compared against policy.issuer_authority via has_one
    #[account(address = authority.key())]
    pub issuer_authority: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Execute<'info> {
    /// CHECK: validated once the hook body is implemented
    pub source_token: UncheckedAccount<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    /// CHECK: validated once the hook body is implemented
    pub destination_token: UncheckedAccount<'info>,
    /// CHECK: validated once the hook body is implemented
    pub owner: UncheckedAccount<'info>,
    /// CHECK: validated once the hook body is implemented
    pub extra_account_meta_list: UncheckedAccount<'info>,
}

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
