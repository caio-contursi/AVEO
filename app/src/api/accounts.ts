// Read accounts through RPC and record their shared observation slot (spec v3, section 7).
import { DeskError } from '@aveo/contracts'
import { getBase64Encoder, type Address } from '@solana/kit'
import type { ApiContext } from './context'
import { throwIfReadAborted, withReadAbort } from './cancellation'

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

export type RpcReader = Pick<ApiContext, 'rpc' | 'commitment' | 'readAbortSignal'>

/**
 * Read accounts at one slot with a 10-second deadline by default.
 * Empty requests return slot 0 without observing the chain; a positive minimum is rejected.
 */
export async function readAccounts(
  ctx: RpcReader,
  addresses: Address[],
  minContextSlot?: number,
  timeoutMs = 10_000,
): Promise<AccountsRead> {
  throwIfReadAborted(ctx.readAbortSignal)
  if (minContextSlot !== undefined && (!Number.isSafeInteger(minContextSlot) || minContextSlot < 0)) {
    throw new DeskError('ReadUnverifiable', 'Invalid minimum account read slot.')
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new DeskError('ReadUnverifiable', 'Invalid account read timeout.')
  }
  if (addresses.length === 0) {
    if (minContextSlot !== undefined && minContextSlot > 0) {
      throw new DeskError('ReadUnverifiable', 'Empty account read cannot satisfy a minimum slot.')
    }
    // Slot 0 is a sentinel, not an observed chain slot.
    return { slot: 0, accounts: [] }
  }

  const controller = new AbortController()
  const onAbort = () => controller.abort()
  ctx.readAbortSignal?.addEventListener('abort', onAbort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new DeskError('ReadUnverifiable', 'Account read timed out.'))
        controller.abort()
      }, timeoutMs)
    })
    // Race also bounds transports that ignore cancellation; late rejections remain handled.
    const response = await withReadAbort(ctx.readAbortSignal, () =>
      Promise.race([
        ctx.rpc
          .getMultipleAccounts(addresses, {
            encoding: 'base64',
            commitment: ctx.commitment,
            ...(minContextSlot !== undefined ? { minContextSlot: BigInt(minContextSlot) } : {}),
          })
          .send({ abortSignal: controller.signal }),
        deadline,
      ]),
    )
    const rawSlot = response?.context?.slot
    const slot = typeof rawSlot === 'bigint' || typeof rawSlot === 'number' ? Number(rawSlot) : NaN
    if (!Number.isSafeInteger(slot) || slot < 0 || (minContextSlot !== undefined && slot < minContextSlot)) {
      throw new DeskError('ReadUnverifiable', 'Account read returned an invalid or stale slot.')
    }
    if (!Array.isArray(response.value) || response.value.length !== addresses.length) {
      throw new DeskError('ReadUnverifiable', 'Account read returned an invalid account count.')
    }
    return {
      slot,
      accounts: Array.from(response.value, (info, i) =>
        info === null
          ? null
          : {
              address: addresses[i]!,
              owner: info.owner,
              lamports: BigInt(info.lamports),
              executable: info.executable,
              data: new Uint8Array(base64.encode(info.data[0])),
            },
      ),
    }
  } catch (error) {
    throwIfReadAborted(ctx.readAbortSignal)
    if (error instanceof DeskError) throw error
    throw new DeskError('ReadUnverifiable', 'Account read failed.')
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    ctx.readAbortSignal?.removeEventListener('abort', onAbort)
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
