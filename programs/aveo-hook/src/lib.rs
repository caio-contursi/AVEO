//! Aveo Transfer Hook (Rota B): Token-2022 enforcement that reads live SAS proofs.
//!
//! The hook only reads. Authorization is never granted by the Desk, a binding flag,
//! or a caller-chosen proof.

pub mod constants;
pub mod eligibility;
pub mod errors;
pub mod extra_metas;
pub mod payload;
pub mod sas;
pub mod state;
pub mod token_accounts;

use crate::constants::*;
use crate::eligibility::{
    load_binding, load_policy, require_live_eligibility, require_presented_proof,
};
use crate::errors::AveoError;
use crate::extra_metas::{extra_account_meta_list_size, init_extra_account_meta_list};
use crate::state::{EligibilityBinding, IssuerPolicy, PolicyArgs};
use crate::token_accounts::{
    require_transferring, token_account_mint_and_owner, validate_demo_mint,
};
use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, CreateAccount};
use anchor_spl::token_interface::Mint;
use spl_discriminator::SplDiscriminate;
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

declare_id!("ExAoxPmugpGbYTVB31oDTqkkG12PM6neFq4vhM6LJd33");

#[program]
pub mod aveo_hook {
    use super::*;

    pub fn init_policy(ctx: Context<InitPolicy>, args: PolicyArgs) -> Result<()> {
        validate_demo_mint(&ctx.accounts.mint.to_account_info(), &crate::ID)?;
        let mint_authority: Option<Pubkey> = ctx.accounts.mint.mint_authority.into();
        require!(
            mint_authority == Some(ctx.accounts.authority.key()),
            AveoError::MintMismatch
        );

        let policy = &mut ctx.accounts.policy;
        policy.version = LAYOUT_VERSION;
        policy.mint = ctx.accounts.mint.key();
        policy.issuer_authority = ctx.accounts.authority.key();
        policy.sas_program_id = SAS_PROGRAM_ID;
        policy.bump = ctx.bumps.policy;
        policy.policy_version = 1;
        policy.apply(args)?;
        Ok(())
    }

    pub fn update_policy(ctx: Context<UpdatePolicy>, args: PolicyArgs) -> Result<()> {
        let policy = &mut ctx.accounts.policy;
        policy.policy_version = policy.policy_version.saturating_add(1);
        policy.apply(args)?;
        Ok(())
    }

    pub fn init_extra_metas(ctx: Context<InitExtraMetas>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.policy.mint,
            ctx.accounts.mint.key(),
            AveoError::MintMismatch
        );
        validate_demo_mint(&ctx.accounts.mint.to_account_info(), &crate::ID)?;

        let space = extra_account_meta_list_size()?;
        let list = ctx.accounts.extra_account_meta_list.to_account_info();
        require!(list.data_is_empty(), AveoError::MissingExtraAccounts);

        let lamports = Rent::get()?.minimum_balance(space);
        let mint_key = ctx.accounts.mint.key();
        let bump = ctx.bumps.extra_account_meta_list;
        let seeds: &[&[u8]] = &[EXTRA_ACCOUNT_METAS_SEED, mint_key.as_ref(), &[bump]];
        system_program::create_account(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                CreateAccount {
                    from: ctx.accounts.authority.to_account_info(),
                    to: list.clone(),
                },
                &[seeds],
            ),
            lamports,
            space as u64,
            &crate::ID,
        )?;

        init_extra_account_meta_list(&mut list.try_borrow_mut_data()?)?;
        Ok(())
    }

    pub fn set_binding(ctx: Context<SetBinding>) -> Result<()> {
        let clock = Clock::get()?;
        let policy = &ctx.accounts.policy;
        require!(policy.active, AveoError::PolicyMissingOrInactive);
        require_keys_eq!(policy.mint, ctx.accounts.mint.key(), AveoError::MintMismatch);
        require_keys_eq!(
            policy.sas_program_id,
            SAS_PROGRAM_ID,
            AveoError::InvalidSasOwnerOrData
        );

        let subject = ctx.accounts.subject_wallet.key();
        // Pair acceptance and required facts are enforced by `execute`, not here.
        // Otherwise a wallet the policy rejects can never create the binding PDA,
        // and a transfer outside the UI fails in the Token-2022 client
        // (missing extra account) instead of ProviderPairNotAllowed / RequiredFactMissing.
        require_presented_proof(
            policy,
            &subject,
            &ctx.accounts.credential.to_account_info(),
            &ctx.accounts.schema.to_account_info(),
            &ctx.accounts.attestation.to_account_info(),
            ctx.accounts.credential.key,
            ctx.accounts.schema.key,
            ctx.accounts.attestation.key,
            &clock,
        )?;

        ctx.accounts.binding.write(
            ctx.accounts.mint.key(),
            subject,
            ctx.accounts.credential.key(),
            ctx.accounts.schema.key(),
            ctx.accounts.attestation.key(),
            ctx.bumps.binding,
        );
        Ok(())
    }

    /// Token-2022 CPI entry. Discriminator is the official Execute interface,
    /// not the Anchor `global:execute` hash.
    #[instruction(discriminator = ExecuteInstruction::SPL_DISCRIMINATOR_SLICE)]
    pub fn execute(ctx: Context<Execute>, amount: u64) -> Result<()> {
        let _ = amount;
        require_transferring(&ctx.accounts.source_token)?;
        require_transferring(&ctx.accounts.destination_token)?;

        let mint_key = ctx.accounts.mint.key();
        let (source_mint, source_owner) =
            token_account_mint_and_owner(&ctx.accounts.source_token)?;
        let (dest_mint, dest_owner) =
            token_account_mint_and_owner(&ctx.accounts.destination_token)?;
        require_keys_eq!(source_mint, mint_key, AveoError::MintMismatch);
        require_keys_eq!(dest_mint, mint_key, AveoError::MintMismatch);
        validate_demo_mint(&ctx.accounts.mint.to_account_info(), &crate::ID)?;

        require!(
            ctx.remaining_accounts.len() >= EXTRA_META_COUNT,
            AveoError::MissingExtraAccounts
        );

        let extra_metas_info = ctx.accounts.extra_account_meta_list.to_account_info();
        let (expected_extra_metas, _) = Pubkey::find_program_address(
            &[EXTRA_ACCOUNT_METAS_SEED, mint_key.as_ref()],
            &crate::ID,
        );
        require_keys_eq!(
            extra_metas_info.key(),
            expected_extra_metas,
            AveoError::MissingExtraAccounts
        );
        require!(
            !extra_metas_info.data_is_empty() && extra_metas_info.owner == &crate::ID,
            AveoError::MissingExtraAccounts
        );

        let policy = load_policy(&ctx.remaining_accounts[0], &mint_key)?;
        let src_binding = load_binding(&ctx.remaining_accounts[1], &mint_key, &source_owner)?;
        let dst_binding = load_binding(&ctx.remaining_accounts[2], &mint_key, &dest_owner)?;
        let clock = Clock::get()?;

        require_live_eligibility(
            &policy,
            &source_owner,
            &ctx.remaining_accounts[3],
            &ctx.remaining_accounts[4],
            &ctx.remaining_accounts[5],
            &src_binding.credential,
            &src_binding.schema,
            &src_binding.attestation,
            &clock,
        )?;
        require_live_eligibility(
            &policy,
            &dest_owner,
            &ctx.remaining_accounts[6],
            &ctx.remaining_accounts[7],
            &ctx.remaining_accounts[8],
            &dst_binding.credential,
            &dst_binding.schema,
            &dst_binding.attestation,
            &clock,
        )?;
        Ok(())
    }
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
        has_one = issuer_authority @ AveoError::UnauthorizedIssuer,
    )]
    pub policy: Account<'info, IssuerPolicy>,
    /// CHECK: compared against policy.issuer_authority via has_one
    #[account(address = authority.key())]
    pub issuer_authority: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct InitExtraMetas<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        seeds = [POLICY_SEED, mint.key().as_ref()],
        bump = policy.bump,
        has_one = issuer_authority @ AveoError::UnauthorizedIssuer,
    )]
    pub policy: Account<'info, IssuerPolicy>,
    /// CHECK: compared against policy.issuer_authority via has_one
    #[account(address = authority.key())]
    pub issuer_authority: UncheckedAccount<'info>,
    /// CHECK: official ExtraAccountMetaList PDA, created in the instruction
    #[account(
        mut,
        seeds = [EXTRA_ACCOUNT_METAS_SEED, mint.key().as_ref()],
        bump
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetBinding<'info> {
    #[account(mut)]
    pub subject_wallet: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        seeds = [POLICY_SEED, mint.key().as_ref()],
        bump = policy.bump,
        constraint = policy.mint == mint.key() @ AveoError::MintMismatch,
    )]
    pub policy: Account<'info, IssuerPolicy>,
    #[account(
        init_if_needed,
        payer = subject_wallet,
        space = 8 + EligibilityBinding::INIT_SPACE,
        seeds = [BINDING_SEED, mint.key().as_ref(), subject_wallet.key().as_ref()],
        bump
    )]
    pub binding: Account<'info, EligibilityBinding>,
    /// CHECK: official SAS credential, parsed in the instruction
    pub credential: UncheckedAccount<'info>,
    /// CHECK: official SAS schema, parsed in the instruction
    pub schema: UncheckedAccount<'info>,
    /// CHECK: official SAS attestation, parsed in the instruction
    pub attestation: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Execute<'info> {
    /// CHECK: Token-2022 source; owner is read from account data, not this signer
    pub source_token: UncheckedAccount<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    /// CHECK: Token-2022 destination; owner is read from account data
    pub destination_token: UncheckedAccount<'info>,
    /// CHECK: transfer authority; may be a delegate. Not the eligibility subject.
    pub owner: UncheckedAccount<'info>,
    /// CHECK: official ExtraAccountMetaList PDA
    #[account(
        seeds = [EXTRA_ACCOUNT_METAS_SEED, mint.key().as_ref()],
        bump
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,
}

#[cfg(test)]
mod tests;
