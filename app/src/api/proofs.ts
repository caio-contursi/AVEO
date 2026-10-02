// Busca as provas (atestações SAS) que existem para uma carteira, entre os verificadores do manifest.
// Usa getProgramAccounts com filtros memcmp: discriminador de Attestation e o sujeito do payload.
import { getBase58Decoder, getBase64Encoder, type Address, type Base58EncodedBytes } from '@solana/kit'
import { rpcCall } from './accounts'
import { decodeEligibilityPayload, decodeSasAttestation, type EligibilityPayload, type SasAttestation } from './codecs'
import { ATTESTATION_SUBJECT_OFFSET, SAS_DISCRIMINATOR, SAS_PROGRAM_ID } from './constants'
import type { ApiContext } from './context'

export interface ProofCandidate {
  address: Address
  attestation: SasAttestation
  payload?: EligibilityPayload
  verifierId?: string
}

const base64 = getBase64Encoder()
const base58 = getBase58Decoder()

export async function findProofsForWallet(ctx: ApiContext, wallet: Address): Promise<ProofCandidate[]> {
  const discriminator = base58.decode(new Uint8Array([SAS_DISCRIMINATOR.attestation])) as Base58EncodedBytes
  const accounts = await rpcCall(() =>
    ctx.rpc
      .getProgramAccounts(SAS_PROGRAM_ID, {
        encoding: 'base64',
        commitment: ctx.commitment,
        filters: [
          { memcmp: { offset: 0n, bytes: discriminator, encoding: 'base58' } },
          { memcmp: { offset: BigInt(ATTESTATION_SUBJECT_OFFSET), bytes: wallet as unknown as Base58EncodedBytes, encoding: 'base58' } },
        ],
      })
      .send(),
  )

  const known = new Map(ctx.deployment.verifiers.map((v) => [v.credential as string, v]))
  const candidates: ProofCandidate[] = []
  for (const { pubkey, account } of accounts) {
    try {
      const attestation = decodeSasAttestation(new Uint8Array(base64.encode(account.data[0])))
      const verifier = known.get(attestation.credential)
      if (!verifier) continue
      let payload: EligibilityPayload | undefined
      try {
        payload = decodeEligibilityPayload(attestation.data)
      } catch {
        payload = undefined
      }
      if (payload && payload.subjectWallet !== wallet) continue
      candidates.push({ address: pubkey, attestation, payload, verifierId: verifier.id })
    } catch {
      // conta que não é uma atestação válida: ignorada
    }
  }
  return candidates.sort((a, b) => Number(b.attestation.expiry - a.attestation.expiry))
}
