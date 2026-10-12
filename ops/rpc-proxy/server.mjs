import http from 'node:http'
import https from 'node:https'
import { readFileSync, statSync } from 'node:fs'
import { Transform } from 'node:stream'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
const HTTP_METHODS = new Set(['getHealth', 'getGenesisHash', 'getVersion', 'getSlot', 'getBlockHeight',
  'getLatestBlockhash', 'isBlockhashValid', 'getBalance', 'getAccountInfo', 'getMultipleAccounts',
  'getTokenAccountBalance', 'getTokenAccountsByOwner', 'getTokenSupply', 'getProgramAccounts', 'getMinimumBalanceForRentExemption',
  'getSignatureStatuses', 'getTransaction', 'simulateTransaction', 'sendTransaction'])
const WS_METHODS = new Set(['accountSubscribe', 'accountUnsubscribe', 'signatureSubscribe',
  'signatureUnsubscribe', 'slotSubscribe', 'slotUnsubscribe', 'logsSubscribe', 'logsUnsubscribe',
  'rootSubscribe', 'rootUnsubscribe'])
const DEFAULT_ORIGINS = ['https://aveoprotocol.io', 'http://localhost:5173', 'http://127.0.0.1:5173']

export function validateRequest(value, methods = HTTP_METHODS) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && value.jsonrpc === '2.0' && methods.has(value.method)
    && (typeof value.id === 'string' || typeof value.id === 'number')
    && (value.params === undefined || Array.isArray(value.params))
    && (value.method !== 'getProgramAccounts' || (value.params?.[0] === '22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG'
      && value.params?.[1]?.encoding === 'base64'
      && Array.isArray(value.params?.[1]?.filters) && value.params[1].filters.length === 2
      && value.params[1].filters.every(f => f?.memcmp && Number.isSafeInteger(f.memcmp.offset)
        && typeof f.memcmp.bytes === 'string' && f.memcmp.bytes.length > 0 && f.memcmp.bytes.length <= 44)
      && value.params[1].filters.some(f => f.memcmp.offset === 0 && f.memcmp.bytes === '3')
      && value.params[1].filters.some(f => f.memcmp.offset === 106 && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(f.memcmp.bytes))))
}

// Only complete, masked browser messages are accepted. Fragmented requests are deliberately unsupported.
export class ClientFrames extends Transform {
  constructor({ now = Date.now, limit = 30 } = {}) {
    super(); this.pending = Buffer.alloc(0); this.now = now; this.limit = limit
    this.window = now(); this.count = 0; this.bytes = 0
  }
  _flush(callback) {
    callback(this.pending.length ? new Error('Incomplete WebSocket frame') : undefined)
  }
  _transform(chunk, _encoding, callback) {
    try {
      this.bytes += chunk.length
      if (this.bytes > 256 * 1024) throw new Error('WebSocket budget exceeded')
      this.pending = Buffer.concat([this.pending, chunk])
      while (this.pending.length >= 2) {
        const b = this.pending; const opcode = b[0] & 15
        if (!(b[0] & 128) || (b[0] & 112) || !(b[1] & 128)) throw new Error('Unsupported frame')
        let size = b[1] & 127; let offset = 2
        if (size === 127) throw new Error('Frame too large')
        if (size === 126) { if (b.length < 4) break; size = b.readUInt16BE(2); offset = 4 }
        if (size > 8192 || (opcode >= 8 && size > 125)) throw new Error('Frame too large')
        if (b.length < offset + 4 + size) break
        if (this.now() - this.window >= 60_000) { this.window = this.now(); this.count = 0 }
        if (++this.count > this.limit) throw new Error('WebSocket rate exceeded')
        const frame = b.subarray(0, offset + 4 + size)
        if (opcode === 1) {
          const payload = Buffer.alloc(size)
          for (let i = 0; i < size; i++) payload[i] = b[offset + 4 + i] ^ b[offset + i % 4]
          if (!validateRequest(JSON.parse(payload.toString('utf8')), WS_METHODS)) throw new Error('Method denied')
        } else if (![8, 9, 10].includes(opcode)) throw new Error('Unsupported opcode')
        this.push(frame); this.pending = b.subarray(frame.length)
      }
      callback()
    } catch { callback(new Error('WebSocket request rejected')) }
  }
}

export function createProxy({ key, fetchImpl = fetch, origins = DEFAULT_ORIGINS, now = Date.now,
  maxRequests = 240, maxConcurrent = 32, maxResponses = 8, requestIntervalMs = 150, maxSockets = 8, timeoutMs = 15_000,
  programScanIntervalMs = 250, sendIntervalMs = 1100,
  handshakeTimeoutMs = 10_000, socketLifetimeMs = 5 * 60_000, upstreamRequest = https.request } = {}) {
  if (!key || !/^[A-Za-z0-9_-]{16,256}$/.test(key)) throw new Error('Invalid RPC credential')
  const endpoint = `https://devnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`
  let started = now(); let requests = 0; let active = 0; let sockets = 0
  let responseSlots = 0; let nextRequestAt = 0; let pumpTimer
  const methodNext = { getProgramAccounts: 0, sendTransaction: 0 }
  const queue = []
  const pump = () => {
    clearTimeout(pumpTimer)
    if (!queue.length || responseSlots >= maxResponses) return
    const wait = Math.max(0, nextRequestAt - now(), (methodNext[queue[0].method] ?? 0) - now())
    if (wait) { pumpTimer = setTimeout(pump, wait); return }
    const job = queue.shift()
    if (job.signal.aborted) { job.reject(new Error('RPC deadline')); pump(); return }
    responseSlots++; nextRequestAt = now() + requestIntervalMs
    if (job.method === 'getProgramAccounts') methodNext.getProgramAccounts = now() + programScanIntervalMs
    if (job.method === 'sendTransaction') methodNext.sendTransaction = now() + sendIntervalMs
    job.signal.removeEventListener('abort', job.abort)
    job.resolve(); pump()
  }
  const acquire = (signal, method) => new Promise((resolve, reject) => {
    const job = { signal, method, resolve, reject, abort: undefined }
    job.abort = () => {
      const index = queue.indexOf(job)
      if (index >= 0) queue.splice(index, 1)
      reject(new Error('RPC deadline')); pump()
    }
    if (signal.aborted) { reject(new Error('RPC deadline')); return }
    signal.addEventListener('abort', job.abort, { once: true }); queue.push(job); pump()
  })
  const allowedOrigin = (req) => !req.headers.origin || origins.includes(req.headers.origin)
  const admit = () => {
    if (now() - started >= 60_000) { started = now(); requests = 0 }
    return ++requests <= maxRequests
  }
  const reply = (res, status, error) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      ...(status === 429 ? { 'Retry-After': '60' } : {}) })
    res.end(JSON.stringify({ error }))
  }
  const server = http.createServer(async (req, res) => {
    if (req.url === '/healthz' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end('{"ok":true}'); return
    }
    if (req.url !== '/rpc') return reply(res, 404, 'Not found')
    if (!allowedOrigin(req)) return reply(res, 403, 'Origin denied')
    if (req.method !== 'POST') return reply(res, 405, 'POST required')
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) return reply(res, 415, 'JSON required')
    if (!admit() || active >= maxConcurrent) return reply(res, 429, 'RPC capacity reached')
    active++
    const controller = new AbortController()
    let released = false; let holdsResponseSlot = false
    const release = () => {
      if (!released) {
        released = true; active--; clearTimeout(timer)
        if (holdsResponseSlot) { holdsResponseSlot = false; responseSlots--; pump() }
      }
    }
    const timer = setTimeout(() => { controller.abort(); req.destroy(); res.destroy(); release() }, timeoutMs)
    res.once('finish', release); res.once('close', release)
    const aborted = () => controller.abort()
    req.once('aborted', aborted)
    res.once('close', () => { if (!res.writableEnded) controller.abort() })
    try {
      let length = 0; const chunks = []
      for await (const chunk of req) {
        length += chunk.length
        if (length > 128 * 1024) { reply(res, 413, 'Request too large'); return }
        chunks.push(chunk)
      }
      let body
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return reply(res, 400, 'Invalid JSON') }
      if (!validateRequest(body)) return reply(res, 400, 'RPC method or envelope denied')
      await acquire(controller.signal, body.method)
      holdsResponseSlot = true
      if (released || controller.signal.aborted) { responseSlots--; holdsResponseSlot = false; pump(); return }
      // Deliberately one attempt, including sendTransaction: an ambiguous send must never be repeated here.
      const upstream = await fetchImpl(endpoint, { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal })
      if (!upstream.ok) return reply(res, upstream.status === 429 ? 429 : 502, 'Upstream RPC unavailable')
      let size = 0; const parts = []
      for await (const chunk of upstream.body) {
        size += chunk.length
        if (size > 8 * 1024 * 1024) { controller.abort(); return reply(res, 502, 'RPC response too large') }
        parts.push(Buffer.from(chunk))
      }
      const value = JSON.parse(Buffer.concat(parts).toString('utf8'))
      if (!value || value.jsonrpc !== '2.0' || value.id !== body.id) return reply(res, 502, 'Invalid RPC response')
      if (value.error) value.error = { code: typeof value.error.code === 'number' ? value.error.code : -32603,
        message: 'Upstream RPC rejected the request' }
      const output = JSON.stringify(value).split(key).join('[redacted]')
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(output)
    } catch { if (!res.headersSent && !res.destroyed) reply(res, 502, 'RPC request unavailable; do not automatically resend') }
    finally { req.removeListener('aborted', aborted) }
  })
  server.requestTimeout = 20_000; server.headersTimeout = 10_000
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy())
    if (!['/rpc', '/rpc-ws'].includes(req.url) || !allowedOrigin(req) || !req.headers.origin
      || !admit() || sockets >= maxSockets || req.headers['sec-websocket-version'] !== '13'
      || !/^[A-Za-z0-9+/]{22}==$/.test(req.headers['sec-websocket-key'] ?? '')) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      const rejection = setTimeout(() => socket.destroy(), 1000); rejection.unref()
      socket.once('close', () => clearTimeout(rejection)); return
    }
    sockets++
    let upstreamSocket; let closed = false; let outputBytes = 0
    const guard = new ClientFrames({ now })
    const upstream = upstreamRequest(endpoint, { method: 'GET', headers: {
      Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': req.headers['sec-websocket-key'],
    } })
    const lifetime = setTimeout(() => close(), socketLifetimeMs)
    const handshake = setTimeout(() => close(), handshakeTimeoutMs)
    const close = () => {
      if (closed) return; closed = true; sockets--; clearTimeout(lifetime); clearTimeout(handshake)
      upstream.destroy(); upstreamSocket?.destroy(); guard.destroy(); socket.destroy()
    }
    guard.on('error', close); socket.on('error', close); socket.on('close', close)
    upstream.on('error', close); upstream.setTimeout(10_000, close)
    upstream.on('response', close)
    upstream.on('upgrade', (response, remote, initial) => {
      if (closed) { remote.destroy(); return }
      const expected = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
      if (response.statusCode !== 101 || response.headers['sec-websocket-accept'] !== expected) { remote.destroy(); close(); return }
      clearTimeout(handshake)
      upstreamSocket = remote; upstream.setTimeout(0)
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
        + `Sec-WebSocket-Accept: ${response.headers['sec-websocket-accept']}\r\n\r\n`)
      remote.on('error', close); remote.on('close', close)
      remote.on('data', (chunk) => { outputBytes += chunk.length; if (outputBytes > 8 * 1024 * 1024) close() })
      outputBytes += initial.length
      if (outputBytes > 8 * 1024 * 1024) { close(); return }
      if (initial.length) socket.write(initial)
      socket.pipe(guard).pipe(remote); remote.pipe(socket)
      if (head.length) guard.write(head)
    })
    upstream.end()
  })
  return server
}

async function start() {
  const file = process.env.HELIUS_KEY_FILE ?? '/run/secrets/helius_devnet_key'
  const stat = statSync(file)
  if (!stat.isFile() || (stat.mode & 0o077)) throw new Error('RPC credential must be a private file')
  const key = readFileSync(file, 'utf8').trim()
  const server = createProxy({ key })
  const response = await fetch(`https://devnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getGenesisHash' }), signal: AbortSignal.timeout(15_000),
  })
  let size = 0; const chunks = []
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > 4096) throw new Error('Invalid devnet response')
    chunks.push(Buffer.from(chunk))
  }
  if (!response.ok || JSON.parse(Buffer.concat(chunks).toString('utf8')).result !== GENESIS) throw new Error('Devnet identity check failed')
  server.listen(Number(process.env.RPC_PORT ?? 8787), process.env.RPC_BIND_HOST ?? '127.0.0.1', () => console.log('Aveo devnet RPC intermediary ready'))
  for (const event of ['SIGTERM', 'SIGINT']) process.on(event, () => { server.close(); setTimeout(() => process.exit(0), 1000).unref() })
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch(() => { console.error('RPC intermediary startup failed; private details suppressed'); process.exitCode = 1 })
}
