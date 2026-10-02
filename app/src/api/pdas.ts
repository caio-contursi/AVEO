// Endereços derivados (PDAs) do aveo-hook e do SAS, com as mesmas seeds do programa.
import { getAddressEncoder, getProgramDerivedAddress, type Address, type ReadonlyUint8Array } from '@solana/kit'
import { SAS_PROGRAM_ID, SEEDS } from './constants'

const encodeAddress = (value: Address) => getAddressEncoder().encode(value)
const utf8 = (value: string) => new TextEncoder().encode(value)

async function pda(programAddress: Address, seeds: (string | ReadonlyUint8Array)[]): Promise<Address> {
  const [found] = await getProgramDerivedAddress({
    programAddress,
    seeds: seeds.map((seed) => (typeof seed === 'string' ? utf8(seed) : seed)),
  })
  return found
}

export const findPolicyPda = (programId: Address, mint: Address) =>
  pda(programId, [SEEDS.policy, encodeAddress(mint)])

export const findBindingPda = (programId: Address, mint: Address, wallet: Address) =>
  pda(programId, [SEEDS.binding, encodeAddress(mint), encodeAddress(wallet)])

export const findExtraAccountMetasPda = (programId: Address, mint: Address) =>
  pda(programId, [SEEDS.extraAccountMetas, encodeAddress(mint)])

/** Igual a SasCredential::derive_address no hook: seeds com o nome inteiro. */
export const findSasCredentialPda = (authority: Address, name: ReadonlyUint8Array) =>
  pda(SAS_PROGRAM_ID, [SEEDS.sasCredential, encodeAddress(authority), name])

export const findSasSchemaPda = (credential: Address, name: ReadonlyUint8Array, version: number) =>
  pda(SAS_PROGRAM_ID, [SEEDS.sasSchema, encodeAddress(credential), name, new Uint8Array([version])])

export const findSasAttestationPda = (credential: Address, schema: Address, nonce: Address) =>
  pda(SAS_PROGRAM_ID, [SEEDS.sasAttestation, encodeAddress(credential), encodeAddress(schema), encodeAddress(nonce)])
