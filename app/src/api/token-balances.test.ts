import { DeskError } from '@aveo/contracts'
import { AccountState, getTokenEncoder } from '@solana-program/token-2022'
import { getAddressDecoder } from '@solana/kit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readAccounts, type RawAccount } from './accounts'
import { TOKEN_2022_PROGRAM_ID } from './constants'
import type { ApiContext } from './context'
import { tokenAccountsFor, tokenBalances } from './transactions'
import type { DeskPlan } from './backend'
import { recheckSubmission } from '../features/operations/execution'

vi.mock('./accounts', async (original) => ({ ...await original<typeof import('./accounts')>(), readAccounts: vi.fn() }))
const decoder = getAddressDecoder()
const mint = decoder.decode(new Uint8Array(32).fill(1))
const owners = [2, 3].map(byte => decoder.decode(new Uint8Array(32).fill(byte)))
const ctx = { commitment: 'confirmed' } as ApiContext

async function fixture() {
  const addresses = await tokenAccountsFor(mint, owners)
  const account = (index: number, amount: bigint, state = AccountState.Initialized): RawAccount => ({
    address: addresses[index]!, owner: TOKEN_2022_PROGRAM_ID, executable: false, lamports: 1n,
    data: new Uint8Array(getTokenEncoder().encode({ mint, owner: owners[index]!, amount, state,
      delegate: null, isNative: null, delegatedAmount: 0n, closeAuthority: null, extensions: null })),
  })
  return { addresses, account }
}

beforeEach(() => vi.clearAllMocks())

describe('validated post-confirmation ATA balances', () => {
  it('preserves subjects, bigint amounts and the read slot for initialized and frozen accounts', async () => {
    const f = await fixture()
    vi.mocked(readAccounts).mockResolvedValue({ slot: 123, accounts: [f.account(0, 10n), f.account(1, 20n, AccountState.Frozen)] })
    await expect(tokenBalances(ctx, mint, owners)).resolves.toEqual({ slot: 123, balances: [10n, 20n] })
    expect(readAccounts).toHaveBeenCalledWith(ctx, f.addresses)
  })

  it('distinguishes a genuinely absent account from an observed zero balance', async () => {
    const f = await fixture()
    vi.mocked(readAccounts).mockResolvedValue({ slot: 123, accounts: [null, f.account(1, 0n)] })
    await expect(tokenBalances(ctx, mint, owners)).resolves.toEqual({ slot: 123, balances: [0n, 0n] })
  })

  it.each(['malformed', 'wrong subject', 'wrong program', 'wrong address', 'uninitialized'] as const)(
    'rejects %s rather than manufacturing zero readback evidence', async (invalid) => {
      const f = await fixture()
      let account = f.account(1, 20n)
      if (invalid === 'malformed') account = { ...account, data: new Uint8Array([1]) }
      else if (invalid === 'wrong subject') account = { ...f.account(0, 20n), address: f.addresses[1]! }
      else if (invalid === 'wrong program') account = { ...account, owner: mint }
      else if (invalid === 'wrong address') account = { ...account, address: f.addresses[0]! }
      else account = f.account(1, 20n, AccountState.Uninitialized)
      vi.mocked(readAccounts).mockResolvedValue({ slot: 123, accounts: [f.account(0, 10n), account] })
      await expect(tokenBalances(ctx, mint, owners)).rejects.toMatchObject({ code: 'ReadUnverifiable', message: 'ReadUnverifiable' })
    },
  )

  it('retains a failed RPC observation as an error rather than empty balances', async () => {
    const error = new DeskError('ReadUnverifiable')
    vi.mocked(readAccounts).mockRejectedValue(error)
    await expect(tokenBalances(ctx, mint, owners)).rejects.toBe(error)
  })

  it('keeps invalid readback unknown with the original signature, rather than inventing balance evidence', async () => {
    const f = await fixture()
    vi.mocked(readAccounts).mockResolvedValue({ slot: 123, accounts: [f.account(0, 10n), { ...f.account(1, 20n), data: new Uint8Array([1]) }] })
    const signature = 'original-signature'
    const backend = { verifyOutcome: vi.fn(async () => {
      await tokenBalances(ctx, mint, owners)
      return { status: 'confirmed' as const, signature, logs: [] }
    }) }
    const evidence = await recheckSubmission({ ctx, backend, signature, plan: {} as DeskPlan })
    expect(evidence).toMatchObject({ status: 'unknown', signature, error: { code: 'ConfirmationUnknown', message: 'ReadUnverifiable' } })
    expect(evidence.balances).toBeUndefined()
    expect(backend.verifyOutcome).toHaveBeenCalledOnce()
  })
})
