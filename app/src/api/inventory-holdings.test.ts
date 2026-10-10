import { DeskError } from '@aveo/contracts'
import { AccountState, extension, getTokenEncoder, type TokenArgs } from '@solana-program/token-2022'
import { getAddressDecoder, type Address } from '@solana/kit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readAccounts, type RawAccount } from './accounts'
import { TOKEN_2022_PROGRAM_ID } from './constants'
import type { ApiContext } from './context'
import { readHoldings } from './inventory'
import { tokenAccountsFor } from './transactions'

vi.mock('./accounts', () => ({ readAccounts: vi.fn(), rpcCall: vi.fn() }))

const addr = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n))
const encoder = getTokenEncoder()

async function fixture() {
  const assets = [addr(1), addr(2)].map((mint, i) => ({ mint, id: `asset-${i}`, label: `Asset ${i}`, symbol: `A${i}`, decimals: 0 }))
  const wallets = [addr(3), addr(4)].map((address, i) => ({ address, id: `wallet-${i}`, label: `Wallet ${i}`, role: 'investor' as const }))
  const ctx = { commitment: 'confirmed', deployment: { assets, wallets } } as ApiContext
  const pairs = assets.flatMap((asset) => wallets.map((wallet) => ({ mint: asset.mint, wallet: wallet.address })))
  const addresses = (await Promise.all(assets.map((asset) => tokenAccountsFor(asset.mint, wallets.map((wallet) => wallet.address))))).flat()
  const token = (i: number, overrides: Partial<TokenArgs> = {}): RawAccount => ({
    address: addresses[i]!, owner: TOKEN_2022_PROGRAM_ID, executable: false, lamports: 1n,
    data: new Uint8Array(encoder.encode({
      mint: pairs[i]!.mint, owner: pairs[i]!.wallet, amount: BigInt(i + 1),
      delegate: null, state: AccountState.Initialized, isNative: null,
      delegatedAmount: 0n, closeAuthority: null, extensions: null, ...overrides,
    })),
  })
  return { ctx, pairs, addresses, token }
}

async function expectUnverifiable(promise: ReturnType<typeof readHoldings>) {
  await expect(promise).rejects.toBeInstanceOf(DeskError)
  await expect(promise).rejects.toMatchObject({ name: 'DeskError', code: 'ReadUnverifiable', message: 'ReadUnverifiable' })
  await promise.catch((error: DeskError) => {
    expect(Object.keys(error).sort()).toEqual(['code', 'name'])
    expect(error.cause).toBeUndefined()
  })
}

describe('readHoldings', () => {
  beforeEach(() => vi.clearAllMocks())

  it('preserves asset/wallet ordering, bigint balances, frozen accounts, missing ATAs and the observation slot', async () => {
    const f = await fixture()
    const amount = 18_446_744_073_709_551_615n
    vi.mocked(readAccounts).mockResolvedValueOnce({ slot: 987654, accounts: [
      f.token(0, { amount }), f.token(1, { amount: 0n }),
      f.token(2, { amount: 42n, state: AccountState.Frozen }), null,
    ] })
    expect(await readHoldings(f.ctx)).toEqual({
      slot: 987654, holdings: f.pairs.map((pair, i) => ({ ...pair, amount: [amount, 0n, 42n, 0n][i] })),
    })
    expect(readAccounts).toHaveBeenCalledExactlyOnceWith(f.ctx, f.addresses)
  })

  it('decodes Token-2022 extensions without discarding valid balances', async () => {
    const f = await fixture()
    vi.mocked(readAccounts).mockResolvedValueOnce({ slot: 123, accounts: f.pairs.map((_, i) => f.token(i, {
      extensions: [extension('TransferHookAccount', { transferring: false })],
    })) })
    expect(await readHoldings(f.ctx)).toEqual({
      slot: 123, holdings: f.pairs.map((pair, i) => ({ ...pair, amount: BigInt(i + 1) })),
    })
  })

  const invalidCases: [string, (account: RawAccount, encode: (overrides: Partial<TokenArgs>) => RawAccount, otherAddress: Address) => RawAccount][] = [
    ['wrong program owner', (account) => ({ ...account, owner: addr(9) })],
    ['wrong mint', (_account, encode) => encode({ mint: addr(9) })],
    ['wrong subject', (_account, encode) => encode({ owner: addr(9) })],
    ['wrong ATA address', (account, _encode, otherAddress) => ({ ...account, address: otherAddress })],
    ['executable account', (account) => ({ ...account, executable: true })],
    ['uninitialized account', (_account, encode) => encode({ state: AccountState.Uninitialized })],
    ['empty bytes', (account) => ({ ...account, data: new Uint8Array() })],
    ['truncated bytes after amount', (account) => ({ ...account, data: account.data.slice(0, 72) })],
    ['invalid state bytes', (account) => {
      const data = account.data.slice()
      data[108] = 255
      return { ...account, data }
    }],
    ['malformed extension bytes', (_account, encode) => {
      const account = encode({ extensions: [extension('TransferHookAccount', { transferring: false })] })
      return { ...account, data: account.data.slice(0, -1) }
    }],
  ]

  it.each(invalidCases)('rejects the entire multi-pair read with a static error for %s', async (_name, invalidate) => {
    const f = await fixture()
    const accounts = f.pairs.map((_, i) => f.token(i))
    accounts[2] = invalidate(accounts[2]!, (overrides) => f.token(2, overrides), f.addresses[0]!)
    vi.mocked(readAccounts).mockResolvedValueOnce({ slot: 456, accounts })
    await expectUnverifiable(readHoldings(f.ctx))
  })

  it('returns zero for an entirely absent inventory while retaining the RPC slot', async () => {
    const f = await fixture()
    vi.mocked(readAccounts).mockResolvedValueOnce({ slot: 789, accounts: f.pairs.map(() => null) })
    expect(await readHoldings(f.ctx)).toEqual({ slot: 789, holdings: f.pairs.map((pair) => ({ ...pair, amount: 0n })) })
  })
})
