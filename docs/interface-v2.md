# Interface aveo-v2 (RASCUNHO — precisa de aprovação do líder)

Contrato entre as frentes F1–F4. Nada aqui é API oficial SAS/MPL; são escolhas Aveo.
Campos marcados **[GATE]** só podem ser preenchidos depois de confirmados no código/SDK oficial.

## 1. Program IDs

| Programa | ID | Fonte |
|---|---|---|
| aveo-hook | [GATE] gerado no primeiro `anchor build` | `target/deploy/` |
| SAS | [GATE] confirmar em attest.solana.com e no SDK | `docs/sas-compatibility.md` |
| Token-2022 | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` | SPL oficial |

## 2. Contas Aveo

### IssuerPolicy — seeds `["policy", mint]`
| Campo | Tipo |
|---|---|
| version | u8 (=2) |
| mint | Pubkey |
| issuer_authority | Pubkey |
| sas_program_id | Pubkey (fixado na implantação, não escolhido pelo caller) |
| proof_domain | [u8; 32] |
| allowed_pairs | [(credential: Pubkey, schema: Pubkey); 2] + `pair_count: u8` |
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

Layout fixo, sem campos variáveis. Offsets (com discriminador Anchor de 8 bytes): [GATE] gerar a partir do build e testar com fixture.

### ExtraAccountMetaList — seeds `["extra-account-metas", mint]` (padrão oficial)

## 3. Instruções

| Instrução | Quem assina | Efeito |
|---|---|---|
| `init_policy` | mint authority atual | cria IssuerPolicy; issuer_authority = signer |
| `update_policy` | issuer_authority | altera pares/requisitos/active; incrementa policy_version |
| `init_extra_metas` | issuer_authority | cria ExtraAccountMetaList |
| `set_binding` | subject_wallet | cria/atualiza binding após validar SAS |
| `execute` | (Token-2022, via CPI) | valida origem e destino; somente leitura |

## 4. Payload SAS `aveo-eligibility-v2`

| Campo | Tipo lógico | Tipo SAS |
|---|---|---|
| version | u8 = 2 | [GATE] |
| subject_wallet | bytes[32] | [GATE] VecU8, tamanho validado = 32 |
| proof_domain | bytes[32] | [GATE] VecU8, tamanho validado = 32 |
| kyc_pass | bool | [GATE] |
| accredited_pass | bool | [GATE] |

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
