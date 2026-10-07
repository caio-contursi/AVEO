// Regras de validate_demo_mint e load_policy aplicadas a contas codificadas pelos clientes oficiais.
import { extension, getMintEncoder, type ExtensionArgs } from '@solana-program/token-2022'
import { getAddressDecoder, none, some } from '@solana/kit'
import { describe, expect, it } from 'vitest'
import type { RawAccount } from './accounts'
import { encodeEligibilityPayload, type IssuerPolicy, type SasAttestation } from './codecs'
import { AVEO_HOOK_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from './constants'
import type { ApiContext } from './context'
import { checkMint, policyRejection } from './eligibility'

const addr = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n))
const ctx = { programId: AVEO_HOOK_PROGRAM_ID } as ApiContext

function mintAccount(extensions: ExtensionArgs[], owner = TOKEN_2022_PROGRAM_ID): RawAccount {
  const data = getMintEncoder().encode({
    mintAuthority: none(),
    supply: 1000n,
    decimals: 0,
    isInitialized: true,
    freezeAuthority: none(),
    extensions: some(extensions),
  })
  return { address: addr(1), owner, lamports: 1n, executable: false, data: new Uint8Array(data) }
}

describe('checkMint (validate_demo_mint)', () => {
  it('aceita mint Token-2022 com o aveo-hook como transfer hook', () => {
    const account = mintAccount([extension('TransferHook', { authority: addr(2), programId: AVEO_HOOK_PROGRAM_ID })])
    expect(checkMint(ctx, account).ok).toBe(true)
  })

  it('recusa hook de outro programa', () => {
    const account = mintAccount([extension('TransferHook', { authority: addr(2), programId: addr(9) })])
    const result = checkMint(ctx, account)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason.code).toBe('MintMismatch')
  })

  it('recusa PermanentDelegate', () => {
    const account = mintAccount([
      extension('TransferHook', { authority: addr(2), programId: AVEO_HOOK_PROGRAM_ID }),
      extension('PermanentDelegate', { delegate: addr(3) }),
    ])
    expect(checkMint(ctx, account).ok).toBe(false)
  })

  it('recusa conta que não é do Token-2022', () => {
    const account = mintAccount([extension('TransferHook', { authority: addr(2), programId: AVEO_HOOK_PROGRAM_ID })], addr(7))
    expect(checkMint(ctx, account).ok).toBe(false)
  })
})

describe('policyRejection (o que a política de um ativo diz de uma prova)', () => {
  const domain = new Uint8Array(32).fill(8)
  const wallet = addr(20)
  const [credentialA, schemaA, credentialB, schemaB] = [addr(30), addr(31), addr(32), addr(33)]
  const beta: IssuerPolicy = {
    version: 2,
    mint: addr(1),
    issuerAuthority: addr(2),
    sasProgramId: addr(3),
    proofDomain: domain,
    pairCount: 1,
    pairs: [{ credential: credentialA, schema: schemaA }],
    requireKyc: true,
    requireAccredited: true,
    active: true,
    policyVersion: 1n,
    bump: 255,
  }
  const proof = (credential: typeof credentialA, schema: typeof schemaA, accredited: boolean, expiry = 2_000_000_000n): SasAttestation => ({
    nonce: addr(40),
    credential,
    schema,
    data: encodeEligibilityPayload({ subjectWallet: wallet, proofDomain: domain, kycPass: true, accreditedPass: accredited }),
    signer: addr(41),
    expiry,
    tokenAccount: addr(42),
  })

  it('aceita a prova de um verificador aceito com todos os fatos', () => {
    expect(policyRejection(beta, wallet, proof(credentialA, schemaA, true))).toBeUndefined()
  })

  it('recusa o verificador que a política não aceita, antes de olhar os fatos', () => {
    expect(policyRejection(beta, wallet, proof(credentialB, schemaB, false))?.code).toBe('ProviderPairNotAllowed')
  })

  it('aponta o fato que falta', () => {
    const result = policyRejection(beta, wallet, proof(credentialA, schemaA, false))
    expect(result).toMatchObject({ code: 'RequiredFactMissing', params: { fact: 'accredited' } })
  })

  it('não confunde validade com aceitação', () => {
    expect(policyRejection(beta, wallet, proof(credentialA, schemaA, true, 0n))).toBeUndefined()
  })
})
