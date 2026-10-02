// Regras de validate_demo_mint e load_policy aplicadas a contas codificadas pelos clientes oficiais.
import { extension, getMintEncoder, type ExtensionArgs } from '@solana-program/token-2022'
import { getAddressDecoder, none, some } from '@solana/kit'
import { describe, expect, it } from 'vitest'
import type { RawAccount } from './accounts'
import { AVEO_HOOK_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from './constants'
import type { ApiContext } from './context'
import { checkMint } from './eligibility'

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
