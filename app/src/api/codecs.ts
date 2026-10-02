// Codecs das contas e instruções do aveo-hook e das contas do SAS.
// Layouts espelham programs/aveo-hook/src/{state,payload,sas}.rs (que por sua vez seguem o SAS oficial).
import {
  addDecoderSizePrefix,
  fixDecoderSize,
  fixEncoderSize,
  getAddressDecoder,
  getAddressEncoder,
  getArrayDecoder,
  getArrayEncoder,
  getBooleanDecoder,
  getBooleanEncoder,
  getBytesDecoder,
  getBytesEncoder,
  getI64Decoder,
  getStructDecoder,
  getStructEncoder,
  getU32Decoder,
  getU32Encoder,
  getU64Decoder,
  getU8Decoder,
  type Address,
  type ReadonlyUint8Array,
} from '@solana/kit'
import {
  ACCOUNT_DISCRIMINATOR,
  AVEO_ELIGIBILITY_V2_DATA_LEN,
  AVEO_ELIGIBILITY_V2_LAYOUT,
  IX_DISCRIMINATOR,
  LAYOUT_VERSION,
  MAX_PAIRS,
  PAYLOAD_VERSION,
  SAS_DISCRIMINATOR,
} from './constants'

export class CodecError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodecError'
  }
}

function startsWith(data: ReadonlyUint8Array, prefix: Uint8Array): boolean {
  if (data.length < prefix.length) return false
  return prefix.every((byte, i) => data[i] === byte)
}

function concat(...parts: ReadonlyUint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

// ---- Contas Aveo ----

export interface ProviderPair {
  credential: Address
  schema: Address
}

export interface IssuerPolicy {
  version: number
  mint: Address
  issuerAuthority: Address
  sasProgramId: Address
  proofDomain: ReadonlyUint8Array
  pairCount: number
  pairs: ProviderPair[]
  requireKyc: boolean
  requireAccredited: boolean
  active: boolean
  policyVersion: bigint
  bump: number
}

const pairDecoder = getStructDecoder([
  ['credential', getAddressDecoder()],
  ['schema', getAddressDecoder()],
])

const issuerPolicyDecoder = getStructDecoder([
  ['version', getU8Decoder()],
  ['mint', getAddressDecoder()],
  ['issuerAuthority', getAddressDecoder()],
  ['sasProgramId', getAddressDecoder()],
  ['proofDomain', fixDecoderSize(getBytesDecoder(), 32)],
  ['pairCount', getU8Decoder()],
  ['pairs', getArrayDecoder(pairDecoder, { size: MAX_PAIRS })],
  ['requireKyc', getBooleanDecoder()],
  ['requireAccredited', getBooleanDecoder()],
  ['active', getBooleanDecoder()],
  ['policyVersion', getU64Decoder()],
  ['bump', getU8Decoder()],
])

export function decodeIssuerPolicy(data: ReadonlyUint8Array): IssuerPolicy {
  if (!startsWith(data, ACCOUNT_DISCRIMINATOR.issuerPolicy)) throw new CodecError('not an IssuerPolicy account')
  const decoded = issuerPolicyDecoder.decode(data, 8)
  if (decoded.pairCount > MAX_PAIRS) throw new CodecError('pair_count above MAX_PAIRS')
  return { ...decoded, pairs: decoded.pairs.slice(0, decoded.pairCount) }
}

export interface EligibilityBinding {
  version: number
  mint: Address
  subjectWallet: Address
  credential: Address
  schema: Address
  attestation: Address
  bump: number
}

const bindingDecoder = getStructDecoder([
  ['version', getU8Decoder()],
  ['mint', getAddressDecoder()],
  ['subjectWallet', getAddressDecoder()],
  ['credential', getAddressDecoder()],
  ['schema', getAddressDecoder()],
  ['attestation', getAddressDecoder()],
  ['bump', getU8Decoder()],
])

export function decodeEligibilityBinding(data: ReadonlyUint8Array): EligibilityBinding {
  if (!startsWith(data, ACCOUNT_DISCRIMINATOR.eligibilityBinding)) {
    throw new CodecError('not an EligibilityBinding account')
  }
  return bindingDecoder.decode(data, 8)
}

// ---- Instruções Aveo ----

export interface PolicyArgs {
  proofDomain: ReadonlyUint8Array
  pairs: ProviderPair[]
  requireKyc: boolean
  requireAccredited: boolean
  active: boolean
}

const policyArgsEncoder = getStructEncoder([
  ['proofDomain', fixEncoderSize(getBytesEncoder(), 32)],
  [
    'pairs',
    getArrayEncoder(
      getStructEncoder([
        ['credential', getAddressEncoder()],
        ['schema', getAddressEncoder()],
      ]),
    ),
  ],
  ['requireKyc', getBooleanEncoder()],
  ['requireAccredited', getBooleanEncoder()],
  ['active', getBooleanEncoder()],
])

export function encodePolicyArgs(args: PolicyArgs): Uint8Array {
  if (args.proofDomain.length !== 32) throw new CodecError('proof_domain must have 32 bytes')
  if (args.pairs.length > MAX_PAIRS) throw new CodecError('at most two provider pairs')
  return new Uint8Array(policyArgsEncoder.encode(args))
}

export function initPolicyData(args: PolicyArgs): Uint8Array {
  return concat(IX_DISCRIMINATOR.initPolicy, encodePolicyArgs(args))
}

export function updatePolicyData(args: PolicyArgs): Uint8Array {
  return concat(IX_DISCRIMINATOR.updatePolicy, encodePolicyArgs(args))
}

export const initExtraMetasData = (): Uint8Array => new Uint8Array(IX_DISCRIMINATOR.initExtraMetas)
export const setBindingData = (): Uint8Array => new Uint8Array(IX_DISCRIMINATOR.setBinding)

// ---- Contas SAS (layout oficial; mesmos parsers de sas.rs) ----

export interface SasCredential {
  authority: Address
  name: ReadonlyUint8Array
  authorizedSigners: Address[]
}

export interface SasSchema {
  credential: Address
  name: ReadonlyUint8Array
  description: ReadonlyUint8Array
  layout: ReadonlyUint8Array
  fieldNames: ReadonlyUint8Array
  isPaused: boolean
  version: number
}

export interface SasAttestation {
  nonce: Address
  credential: Address
  schema: Address
  data: ReadonlyUint8Array
  signer: Address
  expiry: bigint
  tokenAccount: Address
}

const sizedBytes = () => addDecoderSizePrefix(getBytesDecoder(), getU32Decoder())

const credentialDecoder = getStructDecoder([
  ['discriminator', getU8Decoder()],
  ['authority', getAddressDecoder()],
  ['name', sizedBytes()],
  ['authorizedSigners', getArrayDecoder(getAddressDecoder())],
])

const schemaDecoder = getStructDecoder([
  ['discriminator', getU8Decoder()],
  ['credential', getAddressDecoder()],
  ['name', sizedBytes()],
  ['description', sizedBytes()],
  ['layout', sizedBytes()],
  ['fieldNames', sizedBytes()],
  ['isPaused', getBooleanDecoder()],
  ['version', getU8Decoder()],
])

const attestationDecoder = getStructDecoder([
  ['discriminator', getU8Decoder()],
  ['nonce', getAddressDecoder()],
  ['credential', getAddressDecoder()],
  ['schema', getAddressDecoder()],
  ['data', sizedBytes()],
  ['signer', getAddressDecoder()],
  ['expiry', getI64Decoder()],
  ['tokenAccount', getAddressDecoder()],
])

export function decodeSasCredential(data: ReadonlyUint8Array): SasCredential {
  if (data[0] !== SAS_DISCRIMINATOR.credential) throw new CodecError('not a SAS Credential')
  const { authority, name, authorizedSigners } = credentialDecoder.decode(data)
  return { authority, name, authorizedSigners }
}

export function decodeSasSchema(data: ReadonlyUint8Array): SasSchema {
  if (data[0] !== SAS_DISCRIMINATOR.schema) throw new CodecError('not a SAS Schema')
  const { discriminator: _discriminator, ...schema } = schemaDecoder.decode(data)
  return schema
}

export function decodeSasAttestation(data: ReadonlyUint8Array): SasAttestation {
  if (data[0] !== SAS_DISCRIMINATOR.attestation) throw new CodecError('not a SAS Attestation')
  const { discriminator: _discriminator, ...attestation } = attestationDecoder.decode(data)
  return attestation
}

export function isAveoEligibilityV2(schema: SasSchema): boolean {
  return (
    schema.layout.length === AVEO_ELIGIBILITY_V2_LAYOUT.length &&
    schema.layout.every((byte, i) => byte === AVEO_ELIGIBILITY_V2_LAYOUT[i])
  )
}

// ---- Payload aveo-eligibility-v2 (payload.rs) ----

export interface EligibilityPayload {
  version: number
  subjectWallet: Address
  proofDomain: ReadonlyUint8Array
  kycPass: boolean
  accreditedPass: boolean
}

function readBool(byte: number | undefined): boolean {
  if (byte === 0) return false
  if (byte === 1) return true
  throw new CodecError('invalid bool byte')
}

function readU32le(data: ReadonlyUint8Array, offset: number): number {
  return getU32Decoder().decode(data, offset)
}

/** Mesmas regras de EligibilityPayload::decode: 75 bytes exatos, versão 2 e tamanhos 32. */
export function decodeEligibilityPayload(data: ReadonlyUint8Array): EligibilityPayload {
  if (data.length !== AVEO_ELIGIBILITY_V2_DATA_LEN) throw new CodecError('payload must have 75 bytes')
  const version = data[0]
  if (version !== PAYLOAD_VERSION) throw new CodecError('unknown payload version')
  if (readU32le(data, 1) !== 32) throw new CodecError('subject length must be 32')
  const subjectWallet = getAddressDecoder().decode(data, 5)
  if (readU32le(data, 37) !== 32) throw new CodecError('domain length must be 32')
  const proofDomain = data.slice(41, 73)
  return {
    version,
    subjectWallet,
    proofDomain,
    kycPass: readBool(data[73]),
    accreditedPass: readBool(data[74]),
  }
}

export function encodeEligibilityPayload(payload: Omit<EligibilityPayload, 'version'>): Uint8Array {
  if (payload.proofDomain.length !== 32) throw new CodecError('proof_domain must have 32 bytes')
  const u32 = (n: number) => getU32Encoder().encode(n)
  return concat(
    new Uint8Array([PAYLOAD_VERSION]),
    u32(32),
    getAddressEncoder().encode(payload.subjectWallet),
    u32(32),
    payload.proofDomain,
    new Uint8Array([payload.kycPass ? 1 : 0, payload.accreditedPass ? 1 : 0]),
  )
}

export function bytesEqual(a: ReadonlyUint8Array, b: ReadonlyUint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}

export { LAYOUT_VERSION }
