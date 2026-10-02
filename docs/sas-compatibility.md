# SAS compatibility (Rota B)

IDs, layouts and codecs used by `programs/aveo-hook`. Nothing here is invented: each
value has a public source checked on 2026-10-01.

## Program IDs

| Programa | ID | Fonte |
|---|---|---|
| SAS | `22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG` | [solana-attestation-service `program/src/lib.rs`](https://github.com/solana-foundation/solana-attestation-service/blob/master/program/src/lib.rs) e [guia oficial Rust](https://attest.solana.com/docs/guides/rust/how-to-create-digital-credentials) |
| Token-2022 | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` | SPL oficial |

O hook grava `IssuerPolicy.sas_program_id` com o ID acima na implantação. O caller
não escolhe o programa SAS.

## Contas SAS (layout oficial)

Discriminators (`program/src/state/discriminator.rs`):

| Conta | Discriminator |
|---|---|
| Credential | `0` |
| Schema | `1` |
| Attestation | `2` |

PDAs (`program/src/constants.rs` e [helpers](https://attest.solana.com/docs/helpers)):

| Conta | Seeds |
|---|---|
| Credential | `["credential", authority, name]` |
| Schema | `["schema", credential, name, version_u8]` |
| Attestation | `["attestation", credential, schema, nonce]` |

Parsers on-chain espelham `try_from_bytes` do programa oficial (owner = SAS,
PDA conferida, schema pausado recusado, signer tem de estar na lista viva da
credential). `Attestation.token_account` não é usado como sujeito: o sujeito
vem do payload.

## Payload `aveo-eligibility-v2`

Schema SAS pinado (IDs de [schemas](https://attest.solana.com/docs/schemas)):

`[U8=0, VecU8=13, VecU8=13, Bool=10, Bool=10]`

Codec da `Attestation.data` (75 bytes, sem trailing):

| Campo | Encoding |
|---|---|
| version | `u8` = 2 |
| subject_wallet | `u32le` length = 32 + 32 bytes |
| proof_domain | `u32le` length = 32 + 32 bytes |
| kyc_pass | `u8` 0 ou 1 |
| accredited_pass | `u8` 0 ou 1 |

Validade = `Attestation.expiry` (`i64`). `expiry <= Clock.unix_timestamp` ou
`expiry == 0` é recusado.

## Extra metas

Seeds oficiais: `["extra-account-metas", mint]` sob o program ID do hook.
Fonte: [Transfer Hook](https://solana.com/docs/tokens/extensions/transfer-hook).

O owner da token account é lido no offset 32 (layout SPL Token). Bindings
derivam de `(mint, owner)`, não do delegate.
