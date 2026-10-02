use crate::constants::{
    AVEO_ELIGIBILITY_V2_LAYOUT, SAS_ATTESTATION_DISCRIMINATOR, SAS_ATTESTATION_SEED,
    SAS_CREDENTIAL_DISCRIMINATOR, SAS_CREDENTIAL_SEED, SAS_PROGRAM_ID, SAS_SCHEMA_DISCRIMINATOR,
    SAS_SCHEMA_SEED,
};
use crate::errors::AveoError;
use crate::payload::EligibilityPayload;
use anchor_lang::prelude::*;

#[derive(Clone, Debug)]
pub struct SasCredential {
    pub authority: Pubkey,
    pub name: Vec<u8>,
    pub authorized_signers: Vec<Pubkey>,
}

#[derive(Clone, Debug)]
pub struct SasSchema {
    pub credential: Pubkey,
    pub name: Vec<u8>,
    pub layout: Vec<u8>,
    pub is_paused: bool,
    pub version: u8,
}

#[derive(Clone, Debug)]
pub struct SasAttestation {
    pub nonce: Pubkey,
    pub credential: Pubkey,
    pub schema: Pubkey,
    pub data: Vec<u8>,
    pub signer: Pubkey,
    pub expiry: i64,
    pub token_account: Pubkey,
}

fn read_exact<'a>(data: &'a [u8], offset: &mut usize, n: usize) -> Result<&'a [u8]> {
    let end = offset
        .checked_add(n)
        .ok_or_else(|| error!(AveoError::InvalidSasOwnerOrData))?;
    let slice = data
        .get(*offset..end)
        .ok_or_else(|| error!(AveoError::InvalidSasOwnerOrData))?;
    *offset = end;
    Ok(slice)
}

fn read_pubkey(data: &[u8], offset: &mut usize) -> Result<Pubkey> {
    let bytes = read_exact(data, offset, 32)?;
    Pubkey::try_from(bytes).map_err(|_| error!(AveoError::InvalidSasOwnerOrData))
}

fn read_u32(data: &[u8], offset: &mut usize) -> Result<u32> {
    let bytes = read_exact(data, offset, 4)?;
    Ok(u32::from_le_bytes(
        bytes
            .try_into()
            .map_err(|_| error!(AveoError::InvalidSasOwnerOrData))?,
    ))
}

fn read_i64(data: &[u8], offset: &mut usize) -> Result<i64> {
    let bytes = read_exact(data, offset, 8)?;
    Ok(i64::from_le_bytes(
        bytes
            .try_into()
            .map_err(|_| error!(AveoError::InvalidSasOwnerOrData))?,
    ))
}

fn read_vec_u8(data: &[u8], offset: &mut usize) -> Result<Vec<u8>> {
    let len = read_u32(data, offset)? as usize;
    Ok(read_exact(data, offset, len)?.to_vec())
}

impl SasCredential {
    pub fn try_from_account(info: &AccountInfo) -> Result<Self> {
        if info.data_is_empty() || *info.owner == System::id() {
            return err!(AveoError::AttestationMissingOrClosed);
        }
        require_keys_eq!(*info.owner, SAS_PROGRAM_ID, AveoError::InvalidSasOwnerOrData);
        let data = info.try_borrow_data()?;
        Self::try_from_bytes(&data)
    }

    pub fn try_from_bytes(data: &[u8]) -> Result<Self> {
        require!(!data.is_empty(), AveoError::AttestationMissingOrClosed);
        require!(
            data[0] == SAS_CREDENTIAL_DISCRIMINATOR,
            AveoError::InvalidSasOwnerOrData
        );
        let mut offset = 1usize;
        let authority = read_pubkey(data, &mut offset)?;
        let name = read_vec_u8(data, &mut offset)?;
        let signers_len = read_u32(data, &mut offset)? as usize;
        let mut authorized_signers = Vec::with_capacity(signers_len);
        for _ in 0..signers_len {
            authorized_signers.push(read_pubkey(data, &mut offset)?);
        }
        Ok(Self {
            authority,
            name,
            authorized_signers,
        })
    }

    pub fn derive_address(&self) -> Pubkey {
        Pubkey::find_program_address(
            &[
                SAS_CREDENTIAL_SEED,
                self.authority.as_ref(),
                sas_name_seed(&self.name),
            ],
            &SAS_PROGRAM_ID,
        )
        .0
    }

    pub fn is_authorized_signer(&self, signer: &Pubkey) -> bool {
        self.authorized_signers.contains(signer)
    }
}

impl SasSchema {
    pub fn try_from_account(info: &AccountInfo) -> Result<Self> {
        if info.data_is_empty() || *info.owner == System::id() {
            return err!(AveoError::AttestationMissingOrClosed);
        }
        require_keys_eq!(*info.owner, SAS_PROGRAM_ID, AveoError::InvalidSasOwnerOrData);
        let data = info.try_borrow_data()?;
        Self::try_from_bytes(&data)
    }

    pub fn try_from_bytes(data: &[u8]) -> Result<Self> {
        require!(!data.is_empty(), AveoError::AttestationMissingOrClosed);
        require!(
            data[0] == SAS_SCHEMA_DISCRIMINATOR,
            AveoError::InvalidSasOwnerOrData
        );
        let mut offset = 1usize;
        let credential = read_pubkey(data, &mut offset)?;
        let name = read_vec_u8(data, &mut offset)?;
        let _description = read_vec_u8(data, &mut offset)?;
        let layout = read_vec_u8(data, &mut offset)?;
        let _field_names = read_vec_u8(data, &mut offset)?;
        let is_paused_byte = read_exact(data, &mut offset, 1)?;
        let is_paused = is_paused_byte[0] == 1;
        let version_byte = read_exact(data, &mut offset, 1)?;
        let version = version_byte[0];
        Ok(Self {
            credential,
            name,
            layout,
            is_paused,
            version,
        })
    }

    pub fn derive_address(&self) -> Pubkey {
        Pubkey::find_program_address(
            &[
                SAS_SCHEMA_SEED,
                self.credential.as_ref(),
                sas_name_seed(&self.name),
                &[self.version],
            ],
            &SAS_PROGRAM_ID,
        )
        .0
    }

    pub fn is_aveo_eligibility_v2(&self) -> bool {
        self.layout.as_slice() == AVEO_ELIGIBILITY_V2_LAYOUT
    }
}

impl SasAttestation {
    pub fn try_from_account(info: &AccountInfo) -> Result<Self> {
        if info.data_is_empty() || *info.owner == System::id() {
            return err!(AveoError::AttestationMissingOrClosed);
        }
        require_keys_eq!(*info.owner, SAS_PROGRAM_ID, AveoError::InvalidSasOwnerOrData);
        let data = info.try_borrow_data()?;
        Self::try_from_bytes(&data)
    }

    pub fn try_from_bytes(data: &[u8]) -> Result<Self> {
        require!(!data.is_empty(), AveoError::AttestationMissingOrClosed);
        require!(
            data[0] == SAS_ATTESTATION_DISCRIMINATOR,
            AveoError::InvalidSasOwnerOrData
        );
        let mut offset = 1usize;
        let nonce = read_pubkey(data, &mut offset)?;
        let credential = read_pubkey(data, &mut offset)?;
        let schema = read_pubkey(data, &mut offset)?;
        let data_bytes = read_vec_u8(data, &mut offset)?;
        let signer = read_pubkey(data, &mut offset)?;
        let expiry = read_i64(data, &mut offset)?;
        let token_account = read_pubkey(data, &mut offset)?;
        Ok(Self {
            nonce,
            credential,
            schema,
            data: data_bytes,
            signer,
            expiry,
            token_account,
        })
    }

    pub fn derive_address(&self) -> Pubkey {
        Pubkey::find_program_address(
            &[
                SAS_ATTESTATION_SEED,
                self.credential.as_ref(),
                self.schema.as_ref(),
                self.nonce.as_ref(),
            ],
            &SAS_PROGRAM_ID,
        )
        .0
    }

    pub fn payload(&self) -> Result<EligibilityPayload> {
        EligibilityPayload::decode(&self.data)
    }
}

/// SAS PDA seeds cannot exceed 32 bytes. sas-lib 1.0.10 documents that only the
/// first 32 bytes of a credential or schema name are used (`dist/src/pdas.js`).
/// Passing the full name makes `find_program_address` fail, so a valid proof
/// would be rejected. Truncate here; sas-lib itself still requires the prefix.
pub fn sas_name_seed(name: &[u8]) -> &[u8] {
    let end = name.len().min(32);
    &name[..end]
}

/// Validate SAS accounts against the official owner/PDA/layout rules and the
/// Aveo-pinned eligibility schema. `token_account` is not treated as subject.
pub fn load_and_check_sas(
    credential_info: &AccountInfo,
    schema_info: &AccountInfo,
    attestation_info: &AccountInfo,
    expected_credential: &Pubkey,
    expected_schema: &Pubkey,
    expected_attestation: &Pubkey,
) -> Result<(SasCredential, SasSchema, SasAttestation)> {
    require_keys_eq!(
        *credential_info.key,
        *expected_credential,
        AveoError::InvalidSasOwnerOrData
    );
    require_keys_eq!(
        *schema_info.key,
        *expected_schema,
        AveoError::InvalidSasOwnerOrData
    );
    require_keys_eq!(
        *attestation_info.key,
        *expected_attestation,
        AveoError::AttestationMissingOrClosed
    );

    let credential = SasCredential::try_from_account(credential_info)?;
    let schema = SasSchema::try_from_account(schema_info)?;
    let attestation = SasAttestation::try_from_account(attestation_info)?;

    require_keys_eq!(
        credential.derive_address(),
        *credential_info.key,
        AveoError::InvalidSasOwnerOrData
    );
    require_keys_eq!(
        schema.derive_address(),
        *schema_info.key,
        AveoError::InvalidSasOwnerOrData
    );
    require_keys_eq!(
        attestation.derive_address(),
        *attestation_info.key,
        AveoError::InvalidSasOwnerOrData
    );

    require_keys_eq!(
        schema.credential,
        *credential_info.key,
        AveoError::SchemaMismatchOrPaused
    );
    require_keys_eq!(
        attestation.credential,
        *credential_info.key,
        AveoError::InvalidSasOwnerOrData
    );
    require_keys_eq!(
        attestation.schema,
        *schema_info.key,
        AveoError::SchemaMismatchOrPaused
    );
    require_keys_eq!(
        schema.credential,
        attestation.credential,
        AveoError::SchemaMismatchOrPaused
    );

    if schema.is_paused || !schema.is_aveo_eligibility_v2() {
        return err!(AveoError::SchemaMismatchOrPaused);
    }
    if !credential.is_authorized_signer(&attestation.signer) {
        return err!(AveoError::UnauthorizedAttestationSigner);
    }

    Ok((credential, schema, attestation))
}
