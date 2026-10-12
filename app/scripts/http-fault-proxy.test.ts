import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createSolanaRpc, getAddressDecoder, getBase58Decoder, signature } from '@solana/kit'
import { describe, expect, it } from 'vitest'
import { readAccounts } from '../src/api/accounts'
import type { ApiContext } from '../src/api/context'
import { confirmSignature } from '../src/api/transactions'
import { createHttpFaultProxy, requireHttpLoopbackUpstream } from './http-fault-proxy'

const address = getAddressDecoder().decode(new Uint8Array(32).fill(4))
const sig = signature(getBase58Decoder().decode(new Uint8Array(64).fill(5)))
async function fixture(check: (fixture: {
  proxy: Awaited<ReturnType<typeof createHttpFaultProxy>>; ctx: ApiContext; methods: string[]
}) => Promise<void>, redirect = false, rawResult?: string) {
  const methods: string[] = []
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const message = JSON.parse(Buffer.concat(chunks).toString()) as { id: string; method: string }
    methods.push(message.method)
    if (redirect) { res.writeHead(302, { location: 'https://private.invalid/?secret=redacted' }); res.end(); return }
    res.writeHead(200, { 'content-type': 'application/json' })
    if (rawResult) { res.end(`{"jsonrpc":"2.0","id":${JSON.stringify(message.id)},"result":${rawResult}}`); return }
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { context: { slot: 42 }, value: [null] } }))
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const proxy = await createHttpFaultProxy(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`)
  const ctx = { rpc: createSolanaRpc(proxy.endpoint), commitment: 'confirmed' } as unknown as ApiContext
  try { await check({ proxy, ctx, methods }) } finally {
    await proxy.close()
    const closed = new Promise<void>((resolve) => upstream.close(() => resolve()))
    upstream.closeAllConnections()
    await closed
  }
}
function call(endpoint: string, method: string, params: unknown[] = []) {
  return fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
}

describe('loopback HTTP fault transport', () => {
  it.each(['http://127.0.0.1:8899', 'http://localhost:8899', 'http://[::1]:8899/'])('accepts safe HTTP upstream %s', (url) => {
    expect(() => requireHttpLoopbackUpstream(url)).not.toThrow()
  })
  it.each(['https://localhost:8899', 'https://api.devnet.solana.com', 'http://localhost.evil.test',
    'http://user:secret@localhost', 'http://localhost/?key=secret', 'http://localhost/proxy', 'http://localhost/#secret', 'invalid'])('rejects unsafe upstream %s without reflecting input', async (url) => {
    await expect(createHttpFaultProxy(url)).rejects.toThrow()
    try { requireHttpLoopbackUpstream(url) } catch (error) {
      expect((error as Error).message).not.toContain(url)
      expect((error as Error).message).not.toContain('secret')
    }
  })
  it('forwards an actual HTTP account read and keeps ordered response data', async () => fixture(async ({ proxy, ctx, methods }) => {
    expect(proxy.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(await readAccounts(ctx, [address])).toEqual({ slot: 42, accounts: [null] })
    expect(methods).toEqual(['getMultipleAccounts'])
    expect(proxy.select('none')).toEqual({ reads: 1, sends: 0, aborted: 0 })
  }))
  it.each(['sendTransaction', 'requestAirdrop', 'unknownMethod'])('never forwards prohibited method %s', async (method) => fixture(async ({ proxy, methods }) => {
    const response = await call(proxy.endpoint, method, ['secret'])
    expect(await response.json()).toMatchObject({ error: { code: -32601 } })
    expect(methods).toEqual([])
    expect(proxy.select('none')).toEqual({ reads: 0, sends: 1, aborted: 0 })
  }))
  it('returns unknown on actual HTTP 503 without touching the upstream', async () => fixture(async ({ proxy, ctx, methods }) => {
    const counts = proxy.select('unavailable')
    await expect(readAccounts(ctx, [address])).rejects.toMatchObject({ code: 'ReadUnverifiable' })
    expect(methods).toEqual([])
    expect(counts).toEqual({ reads: 1, sends: 0, aborted: 0 })
  }))
  it('rewrites only the final context slot and rejects it below the discovery floor', async () => fixture(async ({ proxy, ctx, methods }) => {
    proxy.select('stale-slot')
    expect((await readAccounts(ctx, [address])).slot).toBe(42)
    await expect(readAccounts(ctx, [address], 42)).rejects.toMatchObject({ code: 'ReadUnverifiable' })
    expect(methods).toHaveLength(2)
  }))
  it('observes cancellation of a suspended actual HTTP account read', async () => fixture(async ({ proxy, ctx, methods }) => {
    const counts = proxy.select('account-timeout')
    await expect(readAccounts(ctx, [address], undefined, 150)).rejects.toMatchObject({ code: 'ReadUnverifiable' })
    await proxy.settleCancellation('account-timeout')
    expect(counts).toEqual({ reads: 1, sends: 0, aborted: 1 })
    expect(methods).toEqual([])
    proxy.select('none')
    expect((await readAccounts(ctx, [address])).slot).toBe(42)
  }))
  it('observes confirmation cancellation without reporting success or sending', async () => fixture(async ({ proxy, ctx, methods }) => {
    const counts = proxy.select('confirmation-timeout')
    expect(await confirmSignature(ctx, sig, 150)).toMatchObject({ status: 'unknown', error: { code: 'ConfirmationUnknown' } })
    await proxy.settleCancellation('confirmation-timeout')
    expect(counts).toEqual({ reads: 1, sends: 0, aborted: 1 })
    expect(methods).toEqual([])
  }))
  it('rejects non-POST paths, malformed JSON, batches and oversized requests without forwarding', async () => fixture(async ({ proxy, methods }) => {
    expect((await fetch(proxy.endpoint)).status).toBe(405)
    expect((await fetch(proxy.endpoint + '/proxy', { method: 'POST' })).status).toBe(405)
    for (const body of ['{"secret":', '[]', '{"jsonrpc":"2.0","method":"sendTransaction"}']) {
      const response = await fetch(proxy.endpoint, { method: 'POST', body })
      expect(response.status).toBe(400)
      expect(await response.text()).not.toContain('secret')
    }
    expect((await fetch(proxy.endpoint, { method: 'POST', body: 'x'.repeat(128_001) })).status).toBe(413)
    expect(methods).toEqual([])
  }))
  it('does not follow upstream redirects or reveal their destinations', async () => fixture(async ({ proxy }) => {
    const response = await call(proxy.endpoint, 'getMultipleAccounts', [[address], { encoding: 'base64' }])
    expect(response.status).toBe(400)
    expect(await response.text()).not.toMatch(/private|secret/)
  }, true))
  it.each(['none', 'stale-slot'] as const)('preserves u64 JSON exactly while changing only the requested context slot (%s)', async (mode) => fixture(async ({ proxy }) => {
    proxy.select(mode)
    const response = await call(proxy.endpoint, 'getMultipleAccounts', [[address], { minContextSlot: 42, encoding: 'base64' }])
    const text = await response.text()
    expect(text).toContain('"lamports":18446744073709551615')
    expect(text).toContain(`"slot":${mode === 'none' ? 42 : 41}`)
    expect(text).toContain('"apiVersion":"2.3.0"')
  }, false, '{"context":{"apiVersion":"2.3.0","slot":42},"value":[{"lamports":18446744073709551615}]}'))
})
