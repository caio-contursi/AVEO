use crate::constants::TOKEN_2022_PROGRAM_ID;
use crate::errors::AveoError;
use anchor_lang::prelude::*;
use spl_token_2022::{
    extension::{
        transfer_hook::{TransferHook, TransferHookAccount},
        BaseStateWithExtensions, ExtensionType, PodStateWithExtensions, StateWithExtensions,
    },
    pod::PodAccount,
    state::Mint,
};

/// Spec 6.1: Token-2022 mint, this program as transfer hook, no PermanentDelegate
/// and no Confidential Transfer.
pub fn validate_demo_mint(mint_info: &AccountInfo, hook_program_id: &Pubkey) -> Result<()> {
    require_keys_eq!(
        *mint_info.owner,
        TOKEN_2022_PROGRAM_ID,
        AveoError::MintMismatch
    );
    let data = mint_info.try_borrow_data()?;
    let mint = StateWithExtensions::<Mint>::unpack(&data)
        .map_err(|_| error!(AveoError::MintMismatch))?;

    let types = mint
        .get_extension_types()
        .map_err(|_| error!(AveoError::MintMismatch))?;
    for ext in types {
        require!(
            ext != ExtensionType::PermanentDelegate
                && ext != ExtensionType::ConfidentialTransferMint
                && ext != ExtensionType::ConfidentialTransferFeeConfig,
            AveoError::MintMismatch
        );
    }

    let hook = mint
        .get_extension::<TransferHook>()
        .map_err(|_| error!(AveoError::MintMismatch))?;
    let program_id = Option::<Pubkey>::from(hook.program_id)
        .ok_or_else(|| error!(AveoError::MintMismatch))?;
    require_keys_eq!(program_id, *hook_program_id, AveoError::MintMismatch);
    Ok(())
}

pub fn require_token_2022(account: &AccountInfo) -> Result<()> {
    require_keys_eq!(
        *account.owner,
        TOKEN_2022_PROGRAM_ID,
        AveoError::MintMismatch
    );
    Ok(())
}

/// Official Transfer Hook context: Token-2022 sets `transferring` on both
/// token accounts for the duration of the CPI. A direct `execute` call fails.
pub fn require_transferring(account: &AccountInfo) -> Result<()> {
    require_token_2022(account)?;
    let data = account.try_borrow_data()?;
    let state = PodStateWithExtensions::<PodAccount>::unpack(&data)
        .map_err(|_| error!(AveoError::NotTransferContext))?;
    let extension = state
        .get_extension::<TransferHookAccount>()
        .map_err(|_| error!(AveoError::NotTransferContext))?;
    require!(
        bool::from(extension.transferring),
        AveoError::NotTransferContext
    );
    Ok(())
}

pub fn token_account_mint_and_owner(account: &AccountInfo) -> Result<(Pubkey, Pubkey)> {
    require_token_2022(account)?;
    let data = account.try_borrow_data()?;
    let state = PodStateWithExtensions::<PodAccount>::unpack(&data)
        .map_err(|_| error!(AveoError::MintMismatch))?;
    Ok((
        Pubkey::from(state.base.mint),
        Pubkey::from(state.base.owner),
    ))
}
