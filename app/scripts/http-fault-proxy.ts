// Ephemeral loopback-only transport for acceptance tests, never a general RPC proxy.
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { FAULT_READ_METHODS } from './fault-read-methods'

export type HttpFault = 'none' | 'unavailable' | 'stale-slot' | 'account-timeout' | 'confirmation-timeout'
const READ_METHODS: ReadonlySet<string> = new Set(FAULT_READ_METHODS)
const MAX_BODY_BYTES = 128_000

export function requireHttpLoopbackUpstream(endpoint: string): void {
  let url: URL
  try { url = new URL(endpoint) } catch { throw new Error('Invalid local HTTP upstream.') }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
    url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('HTTP fault upstream must be a credential-free loopback root endpoint.')
  }
}

export async function createHttpFaultProxy(upstream: string) {
  requireHttpLoopbackUpstream(upstream)
  let mode: HttpFault = 'none'
  const counters = new Map<HttpFault, { reads: number; sends: number; aborted: number }>()
  const pending = new Set<ServerResponse>()
  const controllers = new Set<AbortController>()
  function select(next: HttpFault) {
    mode = next
    let count = counters.get(next)
    if (!count) { count = { reads: 0, sends: 0, aborted: 0 }; counters.set(next, count) }
    return count
  }
  select('none')
  const server = createServer(async (req, res) => {
    const count = select(mode)
    const requestMode = mode
    const reply = (status: number, body: unknown) => {
      if (res.destroyed) return
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const controller = new AbortController()
    controllers.add(controller)
    res.once('close', () => {
      controllers.delete(controller)
      pending.delete(res)
      controller.abort()
    })
    try {
      if (req.method !== 'POST' || req.url !== '/') { reply(405, { error: 'Only root POST requests are accepted.' }); return }
      const chunks: Buffer[] = []
      let length = 0
      for await (const chunk of req) {
        length += chunk.length
        if (length > MAX_BODY_BYTES) { reply(413, { error: 'Request is too large.' }); return }
        chunks.push(Buffer.from(chunk))
      }
      const request: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Invalid request')
      const message = request as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }
      if (message.jsonrpc !== '2.0' || typeof message.method !== 'string' ||
        !(typeof message.id === 'string' || typeof message.id === 'number')) throw new Error('Invalid request')
      if (!READ_METHODS.has(message.method)) {
        count.sends++
        reply(200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Acceptance transport permits only explicit read methods.' } })
        return
      }
      count.reads++
      if (message.method === 'getMultipleAccounts' && requestMode === 'unavailable') {
        reply(503, { error: 'Injected local HTTP unavailability.' }); return
      }
      if ((message.method === 'getMultipleAccounts' && requestMode === 'account-timeout') ||
        (message.method === 'getSignatureStatuses' && requestMode === 'confirmation-timeout')) {
        pending.add(res)
        res.once('close', () => { if (!res.writableEnded) count.aborted++ })
        return // The client deadline closes this actual HTTP request.
      }
      const response = await fetch(upstream, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message),
        redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      })
      if (!response.ok) { reply(502, { error: 'Local upstream read failed.' }); return }
      // Preserve healthy RPC JSON verbatim: parsing/reserializing can round u64 values.
      let responseText = await response.text()
      if (message.method === 'getMultipleAccounts' && requestMode === 'stale-slot' && Array.isArray(message.params)) {
        const floor = (message.params[1] as { minContextSlot?: unknown } | undefined)?.minContextSlot
        if (typeof floor === 'number' && Number.isSafeInteger(floor) && floor > 0) {
          // Only the observation slot is tampered with; account data stays byte-for-byte intact.
          responseText = responseText.replace(/("context"\s*:\s*\{[^{}]*?"slot"\s*:\s*)\d+/, (_match, prefix: string) => `${prefix}${floor - 1}`)
        }
      }
      if (!res.destroyed) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(responseText)
      }
    } catch {
      reply(400, { error: 'Local fault transport could not complete the read.' })
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    endpoint, select,
    async settleCancellation(fault: HttpFault): Promise<void> {
      // Cancellation arrives over a socket after the SDK's deadline promise settles.
      for (let attempt = 0; attempt < 100 && (counters.get(fault)?.aborted ?? 0) === 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    },
    async close(): Promise<void> {
      for (const controller of controllers) controller.abort()
      for (const response of pending) response.destroy()
      const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      server.closeAllConnections()
      await closed
    },
  }
}
