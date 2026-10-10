import { address } from '@solana/kit'
import { describe, expect, it, vi } from 'vitest'
import type { ApiContext } from './context'
import { findProofsForWallet } from './proofs'

const wallet = address('11111111111111111111111111111111')

function setup(signal?: AbortSignal) {
  const send = vi.fn().mockResolvedValue([])
  const getProgramAccounts = vi.fn(() => ({ send }))
  const ctx = { commitment: 'confirmed', readAbortSignal: signal, rpc: { getProgramAccounts },
    deployment: { verifiers: [] } } as unknown as ApiContext
  return { ctx, send, getProgramAccounts }
}

describe('SAS discovery read cancellation', () => {
  it('forwards the preparation signal without changing the discovery filters', async () => {
    const controller = new AbortController()
    const { ctx, send, getProgramAccounts } = setup(controller.signal)
    await expect(findProofsForWallet(ctx, wallet)).resolves.toEqual([])
    expect(send).toHaveBeenCalledWith({ abortSignal: controller.signal })
    expect(getProgramAccounts).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      commitment: 'confirmed', encoding: 'base64', filters: expect.arrayContaining([
        { memcmp: { offset: expect.any(BigInt), bytes: wallet, encoding: 'base58' } },
      ]),
    }))
  })

  it('does not start discovery for an already cancelled preparation', async () => {
    const controller = new AbortController()
    controller.abort('private reason')
    const { ctx, getProgramAccounts } = setup(controller.signal)
    await expect(findProofsForWallet(ctx, wallet)).rejects.toMatchObject({ name: 'AbortError', message: 'Read cancelled.' })
    expect(getProgramAccounts).not.toHaveBeenCalled()
  })

  it('settles promptly and handles a late rejection from an uncooperative transport', async () => {
    const controller = new AbortController()
    const { ctx, send } = setup(controller.signal)
    let rejectRead!: (error: Error) => void
    send.mockImplementation(() => new Promise((_, reject) => { rejectRead = reject }))
    const pending = findProofsForWallet(ctx, wallet)
    controller.abort('private reason')
    await expect(pending).rejects.toMatchObject({ name: 'AbortError', message: 'Read cancelled.' })
    rejectRead(new Error('late private transport failure'))
    await Promise.resolve()
  })
})
