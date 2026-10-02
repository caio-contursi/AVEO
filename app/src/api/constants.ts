// Valores do contrato aveo-v2 (docs/interface-v2.md e programs/aveo-hook/src/constants.rs).
// Nada aqui é inventado: cada valor vem do código do programa ou da documentação do repositório.
import { address, type Address } from '@solana/kit'

/** declare_id! do aveo-hook. Pode ser trocado por VITE_AVEO_PROGRAM_ID se o time publicar em outro endereço. */
export const AVEO_HOOK_PROGRAM_ID: Address = address('ExAoxPmugpGbYTVB31oDTqkkG12PM6neFq4vhM6LJd33')
export const SAS_PROGRAM_ID: Address = address('22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG')
export const TOKEN_2022_PROGRAM_ID: Address = address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
export const SYSTEM_PROGRAM_ID: Address = address('11111111111111111111111111111111')
export const SYSVAR_CLOCK_ID: Address = address('SysvarC1ock11111111111111111111111111111111')

export const SEEDS = {
  policy: 'policy',
  binding: 'binding',
  extraAccountMetas: 'extra-account-metas',
  sasCredential: 'credential',
  sasSchema: 'schema',
  sasAttestation: 'attestation',
} as const

export const LAYOUT_VERSION = 2
export const PAYLOAD_VERSION = 2
export const MAX_PAIRS = 2

/** Schema SAS pinado `aveo-eligibility-v2`: U8, VecU8, VecU8, Bool, Bool. */
export const AVEO_ELIGIBILITY_V2_LAYOUT: readonly number[] = [0, 13, 13, 10, 10]
export const AVEO_ELIGIBILITY_V2_DATA_LEN = 75

export const SAS_DISCRIMINATOR = { credential: 0, schema: 1, attestation: 2 } as const

/** Discriminadores Anchor: sha256("global:<instrução>")[0..8] e sha256("account:<Conta>")[0..8]. */
export const IX_DISCRIMINATOR = {
  initPolicy: new Uint8Array([45, 234, 110, 100, 209, 146, 191, 86]),
  updatePolicy: new Uint8Array([212, 245, 246, 7, 163, 151, 18, 57]),
  initExtraMetas: new Uint8Array([215, 92, 237, 218, 111, 92, 76, 106]),
  setBinding: new Uint8Array([244, 61, 167, 103, 229, 138, 124, 105]),
} as const

export const ACCOUNT_DISCRIMINATOR = {
  issuerPolicy: new Uint8Array([0, 66, 93, 125, 223, 226, 17, 69]),
  eligibilityBinding: new Uint8Array([89, 122, 33, 40, 6, 0, 214, 19]),
} as const

/** 8 (discriminador) + EligibilityBinding::INIT_SPACE. */
export const BINDING_ACCOUNT_SIZE = 170
/** 8 (discriminador) + IssuerPolicy::INIT_SPACE. */
export const ISSUER_POLICY_ACCOUNT_SIZE = 278

/** Offsets do EligibilityBinding usados nas extra metas (constants.rs). */
export const BINDING_OFFSETS = {
  version: 8,
  mint: 9,
  subject: 41,
  credential: 73,
  schema: 105,
  attestation: 137,
  bump: 169,
} as const

/**
 * Offset do sujeito dentro de uma conta Attestation do SAS com o payload aveo-eligibility-v2:
 * discriminador(1) + nonce(32) + credential(32) + schema(32) + tamanho do data(4) + version(1) + tamanho(4).
 */
export const ATTESTATION_SUBJECT_OFFSET = 106
