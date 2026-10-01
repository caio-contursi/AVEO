use crate::constants::{
    BINDING_OFFSET_ATTESTATION, BINDING_OFFSET_CREDENTIAL, BINDING_OFFSET_SCHEMA, BINDING_SEED,
    EXECUTE_IX_DESTINATION, EXECUTE_IX_DST_BINDING, EXECUTE_IX_MINT, EXECUTE_IX_SOURCE,
    EXECUTE_IX_SRC_BINDING, EXTRA_META_COUNT, POLICY_SEED, TOKEN_ACCOUNT_OWNER_OFFSET,
};
use crate::errors::AveoError;
use anchor_lang::prelude::*;
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta, pubkey_data::PubkeyData, seeds::Seed, state::ExtraAccountMetaList,
};
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

pub fn extra_account_metas() -> Result<Vec<ExtraAccountMeta>> {
    let policy = ExtraAccountMeta::new_with_seeds(
        &[
            Seed::Literal {
                bytes: POLICY_SEED.to_vec(),
            },
            Seed::AccountKey {
                index: EXECUTE_IX_MINT as u8,
            },
        ],
        false,
        false,
    )
    .map_err(|_| error!(AveoError::MissingExtraAccounts))?;

    let source_binding = ExtraAccountMeta::new_with_seeds(
        &[
            Seed::Literal {
                bytes: BINDING_SEED.to_vec(),
            },
            Seed::AccountKey {
                index: EXECUTE_IX_MINT as u8,
            },
            Seed::AccountData {
                account_index: EXECUTE_IX_SOURCE as u8,
                data_index: TOKEN_ACCOUNT_OWNER_OFFSET,
                length: 32,
            },
        ],
        false,
        false,
    )
    .map_err(|_| error!(AveoError::MissingExtraAccounts))?;

    let dest_binding = ExtraAccountMeta::new_with_seeds(
        &[
            Seed::Literal {
                bytes: BINDING_SEED.to_vec(),
            },
            Seed::AccountKey {
                index: EXECUTE_IX_MINT as u8,
            },
            Seed::AccountData {
                account_index: EXECUTE_IX_DESTINATION as u8,
                data_index: TOKEN_ACCOUNT_OWNER_OFFSET,
                length: 32,
            },
        ],
        false,
        false,
    )
    .map_err(|_| error!(AveoError::MissingExtraAccounts))?;

    let source_credential = ExtraAccountMeta::new_with_pubkey_data(
        &PubkeyData::AccountData {
            account_index: EXECUTE_IX_SRC_BINDING as u8,
            data_index: BINDING_OFFSET_CREDENTIAL as u8,
        },
        false,
        false,
    )
    .map_err(|_| error!(AveoError::MissingExtraAccounts))?;
    let source_schema = ExtraAccountMeta::new_with_pubkey_data(
        &PubkeyData::AccountData {
            account_index: EXECUTE_IX_SRC_BINDING as u8,
            data_index: BINDING_OFFSET_SCHEMA as u8,
        },
        false,
        false,
    )
    .map_err(|_| error!(AveoError::MissingExtraAccounts))?;
    let source_attestation = ExtraAccountMeta::new_with_pubkey_data(
        &PubkeyData::AccountData {
            account_index: EXECUTE_IX_SRC_BINDING as u8,
            data_index: BINDING_OFFSET_ATTESTATION as u8,
        },
        false,
        false,
    )
    .map_err(|_| error!(AveoError::MissingExtraAccounts))?;

    let dest_credential = ExtraAccountMeta::new_with_pubkey_data(
        &PubkeyData::AccountData {
            account_index: EXECUTE_IX_DST_BINDING as u8,
            data_index: BINDING_OFFSET_CREDENTIAL as u8,
        },
        false,
        false,
    )
    .map_err(|_| error!(AveoError::MissingExtraAccounts))?;
    let dest_schema = ExtraAccountMeta::new_with_pubkey_data(
        &PubkeyData::AccountData {
            account_index: EXECUTE_IX_DST_BINDING as u8,
            data_index: BINDING_OFFSET_SCHEMA as u8,
        },
        false,
        false,
    )
    .map_err(|_| error!(AveoError::MissingExtraAccounts))?;
    let dest_attestation = ExtraAccountMeta::new_with_pubkey_data(
        &PubkeyData::AccountData {
            account_index: EXECUTE_IX_DST_BINDING as u8,
            data_index: BINDING_OFFSET_ATTESTATION as u8,
        },
        false,
        false,
    )
    .map_err(|_| error!(AveoError::MissingExtraAccounts))?;

    let metas = vec![
        policy,
        source_binding,
        dest_binding,
        source_credential,
        source_schema,
        source_attestation,
        dest_credential,
        dest_schema,
        dest_attestation,
    ];
    require!(
        metas.len() == EXTRA_META_COUNT,
        AveoError::MissingExtraAccounts
    );
    Ok(metas)
}

pub fn extra_account_meta_list_size() -> Result<usize> {
    ExtraAccountMetaList::size_of(EXTRA_META_COUNT)
        .map_err(|_| error!(AveoError::MissingExtraAccounts))
}

pub fn init_extra_account_meta_list(data: &mut [u8]) -> Result<()> {
    let metas = extra_account_metas()?;
    ExtraAccountMetaList::init::<ExecuteInstruction>(data, &metas)
        .map_err(|_| error!(AveoError::MissingExtraAccounts))
}
