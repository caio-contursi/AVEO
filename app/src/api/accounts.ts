// Leitura de contas pelo RPC, sempre registrando o slot da leitura (spec v3, seção 7).
import { DeskError } from '@aveo/contracts'
import { getBase64Encoder, type Address } from '@solana/kit'
import type { ApiContext } from './context'

export interface RawAccount {
  address: Address
  owner: Address
  lamports: bigint
  executable: boolean
  data: Uint8Array
}

export interface AccountsRead {
  slot: number
  accounts: (RawAccount | null)[]
}

const base64 = getBase64Encoder()

function toRpcError(error: unknown): DeskError {
  const message = error instanceof Error ? error.message : String(error)
  return new DeskError('ReadUnverifiable', message)
}

export type RpcReader = Pick<ApiContext, 'rpc' | 'commitment'>

/** Lê várias contas numa única chamada, para que todas venham do mesmo slot. */
export async function readAccounts(
  ctx: RpcReader,
  addresses: Address[],
  minContextSlot?: number,
): Promise<AccountsRead> {
  try {
    const response = await ctx.rpc
      .getMultipleAccounts(addresses, {
        encoding: 'base64',
        commitment: ctx.commitment,
        ...(minContextSlot !== undefined ? { minContextSlot: BigInt(minContextSlot) } : {}),
      })
      .send()
    return {
      slot: Number(response.context.slot),
      accounts: response.value.map((info, i) =>
        info
          ? {
              address: addresses[i]!,
              owner: info.owner,
              lamports: BigInt(info.lamports),
              executable: info.executable,
              data: new Uint8Array(base64.encode(info.data[0])),
            }
          : null,
      ),
    }
  } catch (error) {
    throw toRpcError(error)
  }
}

export async function readAccount(ctx: RpcReader, address: Address): Promise<{ slot: number; account: RawAccount | null }> {
  const { slot, accounts } = await readAccounts(ctx, [address])
  return { slot, account: accounts[0] ?? null }
}

export async function rpcCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    throw toRpcError(error)
  }
}
