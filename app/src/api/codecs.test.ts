// Confere os codecs do front contra o contrato do backend:
// - discriminadores Anchor calculados a partir dos nomes do programa;
// - offsets do EligibilityBinding (os mesmos de programs/aveo-hook/src/constants.rs);
// - contas SAS codificadas pelo cliente oficial (sas-lib) e lidas pelos nossos decoders.
import { onchainErrorFromCode } from '@aveo/contracts'
import { getAddressDecoder, getAddressEncoder, getU64Encoder } from '@solana/kit'
import { createHash } from 'node:crypto'
import {
  deriveAttestationPda,
  deriveCredentialPda,
  deriveSchemaPda,
  getAttestationEncoder,
  getCredentialEncoder,
  getSchemaEncoder,
} from 'sas-lib'
import { describe, expect, it } from 'vitest'
import {
  decodeEligibilityBinding,
  decodeEligibilityPayload,
  decodeIssuerPolicy,
  decodeSasAttestation,
  decodeSasCredential,
  decodeSasSchema,
  encodeEligibilityPayload,
  encodePolicyArgs,
  isAveoEligibilityV2,
} from './codecs'
import {
  ACCOUNT_DISCRIMINATOR,
  ATTESTATION_SUBJECT_OFFSET,
  AVEO_ELIGIBILITY_V2_LAYOUT,
  BINDING_ACCOUNT_SIZE,
  BINDING_OFFSETS,
  ISSUER_POLICY_ACCOUNT_SIZE,
  IX_DISCRIMINATOR,
  SAS_PROGRAM_ID,
} from './constants'
import { findSasAttestationPda, findSasCredentialPda, findSasSchemaPda } from './pdas'

const sha8 = (text: string) => Array.from(createHash('sha256').update(text).digest().subarray(0, 8))
const enc = getAddressEncoder()
/** Endereço determinístico para os testes: 32 bytes iguais a n. */
const addr = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n))

describe('discriminadores Anchor', () => {
  it('instruções seguem sha256("global:<nome>")', () => {
    expect(Array.from(IX_DISCRIMINATOR.initPolicy)).toEqual(sha8('global:init_policy'))
    expect(Array.from(IX_DISCRIMINATOR.updatePolicy)).toEqual(sha8('global:update_policy'))
    expect(Array.from(IX_DISCRIMINATOR.initExtraMetas)).toEqual(sha8('global:init_extra_metas'))
    expect(Array.from(IX_DISCRIMINATOR.setBinding)).toEqual(sha8('global:set_binding'))
  })

  it('contas seguem sha256("account:<Nome>")', () => {
    expect(Array.from(ACCOUNT_DISCRIMINATOR.issuerPolicy)).toEqual(sha8('account:IssuerPolicy'))
    expect(Array.from(ACCOUNT_DISCRIMINATOR.eligibilityBinding)).toEqual(sha8('account:EligibilityBinding'))
  })
})

describe('EligibilityBinding', () => {
  const mint = addr(1)
  const subject = addr(2)
  const credential = addr(3)
  const schema = addr(4)
  const attestation = addr(5)
  const data = new Uint8Array([
    ...ACCOUNT_DISCRIMINATOR.eligibilityBinding,
    2,
    ...enc.encode(mint),
    ...enc.encode(subject),
    ...enc.encode(credential),
    ...enc.encode(schema),
    ...enc.encode(attestation),
    254,
  ])

  it('tem o tamanho da conta do programa', () => {
    expect(data.length).toBe(BINDING_ACCOUNT_SIZE)
  })

  it('offsets usados pelas extra metas apontam para credential, schema e attestation', () => {
    const at = (offset: number) => Array.from(data.subarray(offset, offset + 32))
    expect(at(BINDING_OFFSETS.credential)).toEqual(Array.from(enc.encode(credential)))
    expect(at(BINDING_OFFSETS.schema)).toEqual(Array.from(enc.encode(schema)))
    expect(at(BINDING_OFFSETS.attestation)).toEqual(Array.from(enc.encode(attestation)))
    expect(data[BINDING_OFFSETS.bump]).toBe(254)
  })

  it('decodifica os campos', () => {
    expect(decodeEligibilityBinding(data)).toEqual({
      version: 2,
      mint,
      subjectWallet: subject,
      credential,
      schema,
      attestation,
      bump: 254,
    })
  })

  it('recusa outro discriminador', () => {
    const wrong = data.slice()
    wrong[0] ^= 0xff
    expect(() => decodeEligibilityBinding(wrong)).toThrow()
  })
})

describe('IssuerPolicy', () => {
  it('decodifica o layout fixo e corta os pares pelo pair_count', () => {
    const domain = new Uint8Array(32).fill(9)
    const data = new Uint8Array([
      ...ACCOUNT_DISCRIMINATOR.issuerPolicy,
      2,
      ...enc.encode(addr(1)),
      ...enc.encode(addr(2)),
      ...enc.encode(SAS_PROGRAM_ID),
      ...domain,
      1,
      ...enc.encode(addr(3)),
      ...enc.encode(addr(4)),
      ...new Uint8Array(64),
      1,
      0,
      1,
      ...getU64Encoder().encode(7n),
      255,
    ])
    expect(data.length).toBe(ISSUER_POLICY_ACCOUNT_SIZE)
    const policy = decodeIssuerPolicy(data)
    expect(policy.pairs).toEqual([{ credential: addr(3), schema: addr(4) }])
    expect(policy.requireKyc).toBe(true)
    expect(policy.requireAccredited).toBe(false)
    expect(policy.active).toBe(true)
    expect(policy.policyVersion).toBe(7n)
    expect(policy.sasProgramId).toBe(SAS_PROGRAM_ID)
  })
})

describe('PolicyArgs', () => {
  it('codifica domínio, pares com prefixo u32 e as três flags', () => {
    const bytes = encodePolicyArgs({
      proofDomain: new Uint8Array(32).fill(1),
      pairs: [{ credential: addr(3), schema: addr(4) }],
      requireKyc: true,
      requireAccredited: false,
      active: true,
    })
    expect(bytes.length).toBe(32 + 4 + 64 + 3)
    expect(Array.from(bytes.subarray(32, 36))).toEqual([1, 0, 0, 0])
    expect(Array.from(bytes.subarray(-3))).toEqual([1, 0, 1])
  })

  it('recusa mais de dois pares', () => {
    const pair = { credential: addr(3), schema: addr(4) }
    expect(() =>
      encodePolicyArgs({
        proofDomain: new Uint8Array(32),
        pairs: [pair, pair, pair],
        requireKyc: true,
        requireAccredited: true,
        active: true,
      }),
    ).toThrow()
  })
})

describe('payload aveo-eligibility-v2', () => {
  const payload = {
    subjectWallet: addr(7),
    proofDomain: new Uint8Array(32).fill(8),
    kycPass: true,
    accreditedPass: false,
  }

  it('ida e volta com 75 bytes exatos', () => {
    const bytes = encodeEligibilityPayload(payload)
    expect(bytes.length).toBe(75)
    expect(decodeEligibilityPayload(bytes)).toEqual({ version: 2, ...payload })
  })

  it('recusa bytes a mais, versão desconhecida, tamanho errado e bool inválido', () => {
    const bytes = encodeEligibilityPayload(payload)
    expect(() => decodeEligibilityPayload(new Uint8Array([...bytes, 0]))).toThrow()
    const version = bytes.slice()
    version[0] = 3
    expect(() => decodeEligibilityPayload(version)).toThrow()
    const length = bytes.slice()
    length[1] = 31
    expect(() => decodeEligibilityPayload(length)).toThrow()
    const bool = bytes.slice()
    bool[73] = 2
    expect(() => decodeEligibilityPayload(bool)).toThrow()
  })
})

describe('contas SAS codificadas pelo sas-lib', () => {
  it('Credential', () => {
    const data = getCredentialEncoder().encode({
      discriminator: 0,
      authority: addr(1),
      name: new TextEncoder().encode('aveo-verificador-a'),
      authorizedSigners: [addr(2), addr(3)],
    })
    const credential = decodeSasCredential(data)
    expect(credential.authority).toBe(addr(1))
    expect(credential.authorizedSigners).toEqual([addr(2), addr(3)])
  })

  it('Schema com o layout pinado', () => {
    const data = getSchemaEncoder().encode({
      discriminator: 1,
      credential: addr(1),
      name: new TextEncoder().encode('aveo-eligibility-v2'),
      description: new TextEncoder().encode('demo'),
      layout: new Uint8Array(AVEO_ELIGIBILITY_V2_LAYOUT),
      fieldNames: new Uint8Array([1, 2, 3]),
      isPaused: false,
      version: 1,
    })
    const schema = decodeSasSchema(data)
    expect(schema.credential).toBe(addr(1))
    expect(isAveoEligibilityV2(schema)).toBe(true)
    expect(schema.isPaused).toBe(false)
    expect(schema.version).toBe(1)
  })

  it('Attestation com payload: o sujeito fica no offset usado na busca', () => {
    const payload = encodeEligibilityPayload({
      subjectWallet: addr(7),
      proofDomain: new Uint8Array(32).fill(8),
      kycPass: true,
      accreditedPass: true,
    })
    const data = getAttestationEncoder().encode({
      discriminator: 2,
      nonce: addr(4),
      credential: addr(1),
      schema: addr(2),
      data: payload,
      signer: addr(3),
      expiry: 1_790_000_000n,
      tokenAccount: addr(5),
    })
    const attestation = decodeSasAttestation(data)
    expect(attestation.expiry).toBe(1_790_000_000n)
    expect(attestation.signer).toBe(addr(3))
    expect(decodeEligibilityPayload(attestation.data).subjectWallet).toBe(addr(7))
    const subject = data.slice(ATTESTATION_SUBJECT_OFFSET, ATTESTATION_SUBJECT_OFFSET + 32)
    expect(Array.from(subject)).toEqual(Array.from(enc.encode(addr(7))))
  })
})

describe('PDAs do SAS', () => {
  it('coincidem com o sas-lib, inclusive no prefixo de 32 bytes', async () => {
    const name = 'aveo-verificador-a'
    const [credential] = await deriveCredentialPda({ authority: addr(1), name })
    expect(await findSasCredentialPda(addr(1), new TextEncoder().encode(name))).toBe(credential)

    // sas-lib 1.0.10 documenta o prefixo de 32 bytes, mas rejeita a string inteira.
    // O hook e o Desk cortam; o endereço tem de bater com o sas-lib chamado no prefixo.
    const longName = 'verifier-name-that-is-definitely-longer-than-32-bytes'
    const prefix = longName.slice(0, 32)
    const [longCredential] = await deriveCredentialPda({ authority: addr(1), name: prefix })
    expect(await findSasCredentialPda(addr(1), new TextEncoder().encode(longName))).toBe(longCredential)
    const [longSchema] = await deriveSchemaPda({ credential: longCredential, name: prefix, version: 1 })
    expect(await findSasSchemaPda(longCredential, new TextEncoder().encode(longName), 1)).toBe(longSchema)

    const [schema] = await deriveSchemaPda({ credential, name: 'aveo-eligibility-v2', version: 1 })
    expect(await findSasSchemaPda(credential, new TextEncoder().encode('aveo-eligibility-v2'), 1)).toBe(schema)

    const [attestation] = await deriveAttestationPda({ credential, schema, nonce: addr(9) })
    expect(await findSasAttestationPda(credential, schema, addr(9))).toBe(attestation)
  })
})

describe('erros on-chain', () => {
  it('seguem a ordem estável 6000–6015 do contrato', () => {
    expect(onchainErrorFromCode(6000)).toBe('NotTransferContext')
    expect(onchainErrorFromCode(6003)).toBe('BindingMissing')
    expect(onchainErrorFromCode(6013)).toBe('AttestationExpired')
    expect(onchainErrorFromCode(6014)).toBe('MissingExtraAccounts')
    expect(onchainErrorFromCode(6015)).toBe('UnauthorizedIssuer')
    expect(onchainErrorFromCode(6016)).toBeUndefined()
  })
})
