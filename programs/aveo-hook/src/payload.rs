use crate::constants::{AVEO_ELIGIBILITY_V2_DATA_LEN, PAYLOAD_VERSION};
use crate::errors::AveoError;
use anchor_lang::prelude::*;

/// Pinned `aveo-eligibility-v2` payload decoded from official SAS field types:
/// U8 + VecU8(32) + VecU8(32) + Bool + Bool. Trailing bytes, unknown versions
/// and unexpected lengths are rejected.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EligibilityPayload {
    pub version: u8,
    pub subject_wallet: Pubkey,
    pub proof_domain: [u8; 32],
    pub kyc_pass: bool,
    pub accredited_pass: bool,
}

fn read_bool(byte: u8) -> Result<bool> {
    match byte {
        0 => Ok(false),
        1 => Ok(true),
        _ => err!(AveoError::InvalidSasOwnerOrData),
    }
}

impl EligibilityPayload {
    pub fn decode(data: &[u8]) -> Result<Self> {
        require!(
            data.len() == AVEO_ELIGIBILITY_V2_DATA_LEN,
            AveoError::InvalidSasOwnerOrData
        );
        let version = data[0];
        require!(version == PAYLOAD_VERSION, AveoError::InvalidSasOwnerOrData);

        let subject_len = u32::from_le_bytes(data[1..5].try_into().unwrap());
        require!(subject_len == 32, AveoError::InvalidSasOwnerOrData);
        let subject_wallet = Pubkey::try_from(&data[5..37])
            .map_err(|_| error!(AveoError::InvalidSasOwnerOrData))?;

        let domain_len = u32::from_le_bytes(data[37..41].try_into().unwrap());
        require!(domain_len == 32, AveoError::InvalidSasOwnerOrData);
        let mut proof_domain = [0u8; 32];
        proof_domain.copy_from_slice(&data[41..73]);

        let kyc_pass = read_bool(data[73])?;
        let accredited_pass = read_bool(data[74])?;

        Ok(Self {
            version,
            subject_wallet,
            proof_domain,
            kyc_pass,
            accredited_pass,
        })
    }

    pub fn encode(&self) -> Result<Vec<u8>> {
        require!(
            self.version == PAYLOAD_VERSION,
            AveoError::InvalidSasOwnerOrData
        );
        let mut out = Vec::with_capacity(AVEO_ELIGIBILITY_V2_DATA_LEN);
        out.push(self.version);
        out.extend_from_slice(&32u32.to_le_bytes());
        out.extend_from_slice(self.subject_wallet.as_ref());
        out.extend_from_slice(&32u32.to_le_bytes());
        out.extend_from_slice(&self.proof_domain);
        out.push(u8::from(self.kyc_pass));
        out.push(u8::from(self.accredited_pass));
        require!(
            out.len() == AVEO_ELIGIBILITY_V2_DATA_LEN,
            AveoError::InvalidSasOwnerOrData
        );
        Ok(out)
    }
}
