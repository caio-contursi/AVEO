import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { EventEmitter, once } from 'node:events'
import { Duplex } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { createProxy } from './server.mjs'

const key = 'synthetic_resource_test_credential'
const read = { jsonrpc: '2.0', id: 1, method: 'getVersion', params: [] }

async function fixture(t, options = {}) {
  const calls = []
  const responses = []
  const connections = new Set()
  const server = createProxy({ key, requestIntervalMs: 0, maxConcurrent: 1, timeoutMs: 100,
    fetchImpl: async (_url, init) => {
      calls.push(init)
      const body = JSON.parse(init.body)
      return Response.json({ jsonrpc: '2.0', id: body.id, result: 123 })
    }, ...options })
  server.on('request', (_req, res) => responses.push(res))
  server.on('connection', socket => {
    connections.add(socket)
    socket.once('close', () => connections.delete(socket))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    for (const socket of connections) socket.destroy()
    await new Promise(resolve => server.close(resolve))
  })
  return { server, calls, responses, port: server.address().port }
}

async function connect(t, f, paused = false) {
  const socket = net.connect(f.port, '127.0.0.1')
  socket.on('error', () => {})
  if (paused) socket.pause()
  else socket.on('data', () => {})
  t.after(() => socket.destroy())
  await once(socket, 'connect')
  return socket
}

function writePost(socket, body, length = Buffer.byteLength(body)) {
  socket.write(`POST /rpc HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${length}\r\n\r\n${body}`)
}

async function until(predicate, timeout = 2000) {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Resource did not settle within the test deadline')
    await delay(5)
  }
}

async function post(f, body = read) {
  const response = await fetch(`http://127.0.0.1:${f.port}/rpc`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(2000),
  })
  const text = await response.text()
  return { status: response.status, text }
}

test('100 ms upload deadline terminates incomplete bodies and releases admission', { timeout: 5000 }, async t => {
  const f = await fixture(t)
  const slow = await connect(t, f)
  writePost(slow, '{', 200)
  await until(() => f.responses.length === 1)
  assert.equal((await post(f)).status, 429)
  assert.equal(f.calls.length, 0)
  await until(() => f.responses[0].destroyed)
  assert.equal((await post(f)).status, 200)
  assert.equal(f.calls.length, 1)
})

test('queued downstream response retains admission and is destroyed at its deadline', { timeout: 5000 }, async t => {
  const f = await fixture(t, { timeoutMs: 500, fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body)
    return Response.json({ jsonrpc: '2.0', id: body.id,
      result: body.id === 1 ? 'x'.repeat(7 * 1024 * 1024) : 123 })
  } })
  // A stalled transport makes backpressure independent of the OS receive-buffer size.
  const slow = new Duplex({ read() {}, write(_chunk, _encoding, _callback) {} })
  slow.setTimeout = () => slow
  slow.setNoDelay = () => slow
  slow.setKeepAlive = () => slow
  slow.on('error', () => {})
  t.after(() => slow.destroy())
  f.server.emit('connection', slow)
  const body = JSON.stringify(read)
  slow.push(Buffer.from(`POST /rpc HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`))
  await until(() => f.responses[0]?.writableEnded)
  const first = f.responses[0]
  assert.equal(first.writableFinished, false, 'Fixture must produce a genuinely backpressured response')
  assert.ok(first.writableLength > 0)
  assert.equal((await post(f, { ...read, id: 2 })).status, 429)
  await until(() => first.destroyed)
  assert.equal(slow.destroyed, true, 'Deadline must terminate the blocked downstream transport')
  assert.equal((await post(f, { ...read, id: 3 })).status, 200)
})

test('disconnect aborts pending upstream work and releases admission', { timeout: 5000 }, async t => {
  let pendingSignal
  const f = await fixture(t, { timeoutMs: 1000, fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body)
    if (body.id !== 1) return Response.json({ jsonrpc: '2.0', id: body.id, result: 123 })
    pendingSignal = init.signal
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort',
      () => reject(new Error('Synthetic upstream abort')), { once: true }))
  } })
  const client = await connect(t, f)
  writePost(client, JSON.stringify(read))
  await until(() => pendingSignal !== undefined)
  client.destroy()
  await until(() => pendingSignal.aborted && f.responses[0].destroyed)
  assert.equal((await post(f, { ...read, id: 2 })).status, 200)
})

class SocketFixture extends Duplex {
  constructor() { super(); this.writes = [] }
  _read() {}
  _write(chunk, _encoding, callback) { this.writes.push(Buffer.from(chunk)); callback() }
}

function websocketFixture(t) {
  const requests = []
  const sockets = []
  const server = createProxy({ key, maxSockets: 1, handshakeTimeoutMs: 100,
    socketLifetimeMs: 250, upstreamRequest: () => {
    const request = new EventEmitter()
    request.destroyed = false
    request.setTimeout = () => request
    request.end = () => {}
    request.destroy = () => { request.destroyed = true }
    requests.push(request)
    return request
  } })
  const upgrade = (origin = 'https://aveoprotocol.io') => {
    const socket = new SocketFixture()
    sockets.push(socket)
    server.emit('upgrade', { url: '/rpc-ws', headers: { origin,
      'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } }, socket, Buffer.alloc(0))
    return socket
  }
  t.after(() => { for (const socket of sockets) socket.destroy() })
  return { requests, upgrade }
}

test('rejected upgrades handle socket errors without consuming admission', t => {
  const f = websocketFixture(t)
  const rejected = f.upgrade('https://evil.example')
  assert.ok(rejected.listenerCount('error') > 0)
  assert.doesNotThrow(() => rejected.emit('error', new Error('Synthetic connection reset')))
  assert.equal(rejected.destroyed, true)
  assert.equal(f.requests.length, 0)
  f.upgrade()
  assert.equal(f.requests.length, 1)
})

test('absolute handshake deadline closes a stalled upstream and recovers the socket slot', { timeout: 5000 }, async t => {
  const f = websocketFixture(t)
  const first = f.upgrade()
  const excess = f.upgrade()
  assert.equal(f.requests.length, 1)
  assert.match(Buffer.concat(excess.writes).toString(), /403 Forbidden/)
  // The fake transport never emits an inactivity timeout: only the absolute timer can close it.
  assert.equal(first.destroyed, false)
  await until(() => first.destroyed)
  assert.equal(first.destroyed, true)
  assert.equal(f.requests[0].destroyed, true)
  f.upgrade()
  assert.equal(f.requests.length, 2)
})

test('invalid upstream WebSocket accept closes both sides and recovers admission', async t => {
  const f = websocketFixture(t)
  const client = f.upgrade()
  const remote = new SocketFixture()
  f.requests[0].emit('upgrade', { statusCode: 101,
    headers: { 'sec-websocket-accept': 'incorrect-accept' } }, remote, Buffer.alloc(0))
  assert.equal(client.destroyed, true)
  assert.equal(remote.destroyed, true)
  assert.equal(f.requests[0].destroyed, true)
  f.upgrade()
  assert.equal(f.requests.length, 2)
})

test('upstream upgrade head counts toward the cumulative outgoing session budget', t => {
  const f = websocketFixture(t)
  const client = f.upgrade()
  const remote = new SocketFixture()
  t.after(() => remote.destroy())
  f.requests[0].emit('upgrade', { statusCode: 101,
    headers: { 'sec-websocket-accept': 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=' } }, remote, Buffer.alloc(1024))
  assert.equal(client.destroyed, false)
  remote.emit('data', Buffer.alloc(8 * 1024 * 1024 - 1024))
  assert.equal(client.destroyed, false, 'Exactly the byte budget should remain permitted')
  remote.emit('data', Buffer.alloc(1))
  assert.equal(client.destroyed, true)
  assert.equal(remote.destroyed, true)
})

test('canceling the queue head allows its successor exactly once', { timeout: 5000 }, async t => {
  const forwarded = []; let releaseFirst
  const f = await fixture(t, { maxConcurrent: 3, maxResponses: 1, timeoutMs: 2000,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body); forwarded.push(body.id)
      if (body.id === 1) await new Promise(resolve => { releaseFirst = resolve })
      return Response.json({ jsonrpc: '2.0', id: body.id, result: 1 })
    },
  })
  const first = post(f)
  await until(() => releaseFirst !== undefined)
  const controller = new AbortController()
  const canceled = fetch(`http://127.0.0.1:${f.port}/rpc`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...read, id: 2 }), signal: controller.signal,
  }).catch(() => undefined)
  await until(() => f.responses.length === 2)
  const successor = post(f, { ...read, id: 3 })
  await until(() => f.responses.length === 3)
  controller.abort(); await until(() => f.responses[1].destroyed)
  releaseFirst()
  assert.equal((await first).status, 200); assert.equal((await successor).status, 200)
  await canceled; assert.deepEqual(forwarded, [1, 3])
})

test('successful handshake clears its deadline but session lifetime still closes the tunnel', { timeout: 5000 }, async t => {
  const f = websocketFixture(t)
  const client = f.upgrade()
  const remote = new SocketFixture()
  t.after(() => remote.destroy())
  f.requests[0].emit('upgrade', { statusCode: 101,
    headers: { 'sec-websocket-accept': 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=' } }, remote, Buffer.alloc(0))
  await delay(125)
  assert.equal(client.destroyed, false)
  await until(() => client.destroyed)
  assert.equal(client.destroyed, true)
  assert.equal(remote.destroyed, true)
  f.upgrade()
  assert.equal(f.requests.length, 2)
})
