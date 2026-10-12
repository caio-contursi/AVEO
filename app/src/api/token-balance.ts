import { DeskError } from '@aveo/contracts'
import { AccountState, getTokenDecoder } from '@solana-program/token-2022'
import type { Address } from '@solana/kit'
import type { RawAccount } from './accounts'
import { TOKEN_2022_PROGRAM_ID } from './constants'

const decoder = getTokenDecoder()

/** Validates observed balance and identity, not transfer authorization; frozen balances are valid. */
export function decodeTokenBalance(
  account: RawAccount | null,
  expected: { address: Address; mint: Address; owner: Address },
): bigint {
  if (account === null) return 0n
  try {
    if (account.address !== expected.address || account.owner !== TOKEN_2022_PROGRAM_ID || account.executable) {
      throw new DeskError('ReadUnverifiable')
    }
    const token = decoder.decode(account.data)
    if (
      token.mint !== expected.mint || token.owner !== expected.owner ||
      (token.state !== AccountState.Initialized && token.state !== AccountState.Frozen)
    ) {
      throw new DeskError('ReadUnverifiable')
    }
    return token.amount
  } catch {
    throw new DeskError('ReadUnverifiable')
  }
}
