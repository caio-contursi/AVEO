import { getAddressDecoder, getBase58Decoder, signature as parseSignature } from '@solana/kit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readAccounts } from '../src/api/accounts'
import type { ApiContext } from '../src/api/context'
import { confirmSignature } from '../src/api/transactions'
import { faultContext, requireLocalFaultEndpoint } from './fault-check'

const address = getAddressDecoder().decode(new Uint8Array(32).fill(3))
const signature = parseSignature(getBase58Decoder().decode(new Uint8Array(64).fill(4)))
function base() {
  const send = vi.fn().mockResolvedValue({ context: { slot: 42n }, value: [null] })
  const sendTransaction = vi.fn()
  const ctx = { commitment: 'confirmed', rpc: {
    getMultipleAccounts: vi.fn(() => ({ send })), sendTransaction,
  } } as unknown as ApiContext
  return { ctx, send, sendTransaction }
}
afterEach(() => { vi.useRealTimers() })

describe('read-only fault acceptance guard', () => {
  it.each(['http://127.0.0.1:8899', 'http://localhost:8899/', 'http://[::1]:8899', 'https://localhost'])('accepts explicit loopback %s', (url) => {
    expect(() => requireLocalFaultEndpoint(url)).not.toThrow()
  })
  it.each(['https://api.devnet.solana.com', 'http://127.0.0.1.evil.test', 'http://user:secret@localhost:8899',
    'http://localhost:8899/?key=secret', 'http://localhost:8899/proxy', 'http://localhost:8899/#secret',
    'file:///localhost', 'not a URL'])('rejects unsafe endpoint without echoing it %s', (url) => {
    expect(() => requireLocalFaultEndpoint(url)).toThrow()
    try { requireLocalFaultEndpoint(url) } catch (error) {
      expect((error as Error).message).not.toContain(url)
      expect((error as Error).message).not.toContain('secret')
    }
  })
  it('preserves real healthy reads and prevents any transaction forwarding', async () => {
    const real = base()
    const fault = faultContext(real.ctx, 'none')
    expect(await readAccounts(fault.ctx, [address])).toEqual({ slot: 42, accounts: [null] })
    expect(real.send).toHaveBeenCalledOnce()
    expect(() => fault.ctx.rpc.sendTransaction('unused' as never)).toThrow('read-only')
    expect(real.sendTransaction).not.toHaveBeenCalled()
    expect(fault.counters).toEqual({ reads: 1, sends: 1, aborted: 0 })
  })
  it('fails unavailable reads closed without forwarding or sending', async () => {
    const real = base()
    const fault = faultContext(real.ctx, 'unavailable')
    await expect(readAccounts(fault.ctx, [address])).rejects.toMatchObject({ code: 'ReadUnverifiable' })
    expect(real.send).not.toHaveBeenCalled()
    expect(fault.counters).toEqual({ reads: 1, sends: 0, aborted: 0 })
  })
  it('leaves discovery healthy but rejects an injected final slot below its floor', async () => {
    const real = base()
    const fault = faultContext(real.ctx, 'stale-slot')
    expect((await readAccounts(fault.ctx, [address])).slot).toBe(42)
    await expect(readAccounts(fault.ctx, [address], 42)).rejects.toMatchObject({ code: 'ReadUnverifiable' })
    expect(real.send).toHaveBeenCalledTimes(2)
    expect(fault.counters).toEqual({ reads: 2, sends: 0, aborted: 0 })
  })
  it('aborts suspended account requests at their deadline with no real transport call', async () => {
    vi.useFakeTimers()
    const real = base()
    const fault = faultContext(real.ctx, 'account-timeout')
    const assertion = expect(readAccounts(fault.ctx, [address], undefined, 75)).rejects.toMatchObject({ code: 'ReadUnverifiable' })
    await vi.advanceTimersByTimeAsync(75)
    await assertion
    expect(real.send).not.toHaveBeenCalled()
    expect(fault.counters).toEqual({ reads: 1, sends: 0, aborted: 1 })
  })
  it('bounds suspended confirmation and never converts it to success or resubmission', async () => {
    vi.useFakeTimers()
    const real = base()
    const fault = faultContext(real.ctx, 'confirmation-timeout')
    const pending = confirmSignature(fault.ctx, signature, 75)
    await vi.advanceTimersByTimeAsync(75)
    expect(await pending).toMatchObject({ status: 'unknown', error: { code: 'ConfirmationUnknown' } })
    expect(fault.counters).toEqual({ reads: 1, sends: 0, aborted: 1 })
    expect(real.sendTransaction).not.toHaveBeenCalled()
  })
})
