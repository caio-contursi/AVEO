# Interface aveo-v2

Contrato entre as frentes F1–F4. Nada aqui é API oficial SAS/MPL; são escolhas Aveo.
Layouts SAS e offsets Aveo foram gerados do código oficial / do build e testados em
`programs/aveo-hook` (ver `docs/sas-compatibility.md`).

## 1. Program IDs

| Programa | ID | Fonte |
|---|---|---|
| aveo-hook | `ExAoxPmugpGbYTVB31oDTqkkG12PM6neFq4vhM6LJd33` | `declare_id!` / `Anchor.toml` (keypair local em `target/deploy/`) |
| SAS | `22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG` | programa oficial SAS; `docs/sas-compatibility.md` |
| Token-2022 | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` | SPL oficial |

## 2. Contas Aveo

### IssuerPolicy — seeds `["policy", mint]`
| Campo | Tipo |
|---|---|
| version | u8 (=2) |
| mint | Pubkey |
| issuer_authority | Pubkey |
| sas_program_id | Pubkey (fixado na implantação ao ID SAS oficial; não vem em `PolicyArgs`) |
| proof_domain | [u8; 32] |
| allowed_pairs | `pairs: [(credential: Pubkey, schema: Pubkey); 2]` + `pair_count: u8` |
| require_kyc | bool |
| require_accredited | bool |
| active | bool |
| policy_version | u64 |
| bump | u8 |

### EligibilityBinding — seeds `["binding", mint, subject_wallet]`
| Campo | Tipo |
|---|---|
| version | u8 (=2) |
| mint | Pubkey |
| subject_wallet | Pubkey |
| credential | Pubkey |
| schema | Pubkey |
| attestation | Pubkey |
| bump | u8 |

Layout fixo, sem campos variáveis. Offsets (com discriminador Anchor de 8 bytes), gerados do layout e testados em `programs/aveo-hook/src/tests.rs`:

| Campo | Offset |
|---|---|
| discriminator | 0 |
| version | 8 |
| mint | 9 |
| subject_wallet | 41 |
| credential | 73 |
| schema | 105 |
| attestation | 137 |
| bump | 169 |

Tamanho da conta = `8 + EligibilityBinding::INIT_SPACE` (170).

### ExtraAccountMetaList — seeds `["extra-account-metas", mint]` (padrão oficial)

## 3. Instruções

| Instrução | Quem assina | Efeito |
|---|---|---|
| `init_policy` | mint authority atual | cria IssuerPolicy; issuer_authority = signer; `sas_program_id` = SAS oficial |
| `update_policy` | issuer_authority | altera pares/requisitos/active; incrementa policy_version; não muda SAS ID |
| `init_extra_metas` | issuer_authority | cria ExtraAccountMetaList oficial |
| `set_binding` | subject_wallet | cria/atualiza binding após validar SAS; não grava `eligible=true` |
| `execute` | (Token-2022, via CPI; discriminator SPL Execute) | valida origem e destino; somente leitura |

`PolicyArgs`: `proof_domain`, `pairs`, `require_kyc`, `require_accredited`, `active`. Sem `sas_program_id`.

`execute` extras (depois das 5 contas padrão Token-2022): policy; binding origem; binding destino; credential/schema/attestation origem; credential/schema/attestation destino. Bindings derivados do **owner** da token account (offset 32), não do delegate.

## 4. Payload SAS `aveo-eligibility-v2`

| Campo | Tipo lógico | Tipo SAS |
|---|---|---|
| version | u8 = 2 | SAS `U8` (1 byte) |
| subject_wallet | bytes[32] | SAS `VecU8`, `u32le` length = 32 |
| proof_domain | bytes[32] | SAS `VecU8`, `u32le` length = 32 |
| kyc_pass | bool | SAS `Bool` (0 ou 1) |
| accredited_pass | bool | SAS `Bool` (0 ou 1) |

Schema SAS pinado: layout `[0, 13, 13, 10, 10]`. `Attestation.data` = 75 bytes exatos.

Validade = `Attestation.expiry` (expiry 0 é recusado).

## 5. Fixtures da demo

| Nome | Papel |
|---|---|
| Verificador A | credential A + schema A |
| Verificador B | credential B + schema B (mesmo layout) |
| Alfa | aceita (A) ou (B); exige KYC |
| Beta | aceita só (A); exige KYC + accredited |
| X | prova A, kyc=true, accredited=true |
| Y | prova B, kyc=true, accredited=false |
| Tesouraria | prova A, ambos true |

## 6. Erros on-chain (ordem estável — não reordenar)

```
6000 NotTransferContext
6001 PolicyMissingOrInactive
6002 MintMismatch
6003 BindingMissing
6004 BindingSubjectMismatch
6005 ProviderPairNotAllowed
6006 SchemaMismatchOrPaused
6007 AttestationMissingOrClosed
6008 InvalidSasOwnerOrData
6009 UnauthorizedAttestationSigner
6010 SubjectMismatch
6011 ProofDomainMismatch
6012 RequiredFactMissing
6013 AttestationExpired
6014 MissingExtraAccounts
```

## 7. Erros do Desk

`BackendNotIntegrated`, `UnsupportedCapability`, `ReadUnverifiable`, `SimulationFailed`, `ConfirmationUnknown`.
