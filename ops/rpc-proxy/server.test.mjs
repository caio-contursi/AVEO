import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createProxy, ClientFrames, validateRequest } from './server.mjs'

const key = 'synthetic_test_key_not_a_real_key'
const request = { jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] }
async function fixture(options = {}) {
  const calls = []
  const server = createProxy({ key, fetchImpl: async (url, init) => {
    calls.push({ url, init })
    return Response.json({ jsonrpc: '2.0', id: 1, result: 123 })
  }, ...options })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  return { calls, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => {
    server.close(resolve); server.closeAllConnections()
  }) }
}
const post = (url, body = request, headers = {}) => fetch(url + '/rpc', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
})
test('validates envelopes, denies batches, faucet and arbitrary methods', () => {
  assert.equal(validateRequest(request), true)
  for (const value of [null, [request], { ...request, method: 'requestAirdrop' },
    { ...request, method: 'getProgramAccounts' }, { ...request, params: {} }, { ...request, id: null }]) {
    assert.equal(validateRequest(value), false)
  }
})
test('forwards one request to a fixed host and exposes no credential', async () => {
  const f = await fixture()
  try {
    const response = await post(f.url)
    assert.equal(response.status, 200); assert.equal((await response.json()).result, 123)
    assert.equal(f.calls.length, 1); assert.equal(new URL(f.calls[0].url).hostname, 'devnet.helius-rpc.com')
    assert.equal(f.calls[0].init.redirect, 'error')
  } finally { await f.close() }
})
test('permits filtered SAS discovery but not unrestricted program scans', () => {
  const body = { ...request, method: 'getProgramAccounts', params: [
    '22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG', { encoding: 'base64', filters: [
      { memcmp: { offset: 0, bytes: '3' } }, { memcmp: { offset: 106, bytes: '11111111111111111111111111111111' } },
    ] },
  ] }
  assert.equal(validateRequest(body), true)
  assert.equal(validateRequest({ ...body, params: [body.params[0], {}] }), false)
  assert.equal(validateRequest({ ...body, params: ['other', body.params[1]] }), false)
})
test('rejects cross-origin requests and arbitrary query paths before upstream', async () => {
  const f = await fixture()
  try {
    assert.equal((await post(f.url, request, { Origin: 'https://evil.example' })).status, 403)
    assert.equal((await fetch(f.url + '/rpc?url=https://evil.example')).status, 404)
    assert.equal(f.calls.length, 0)
  } finally { await f.close() }
})
test('allows published and local browser origins without adding permissive CORS', async () => {
  const f = await fixture()
  try {
    for (const origin of ['https://aveoprotocol.io', 'http://localhost:5173']) {
      const r = await post(f.url, request, { Origin: origin }); assert.equal(r.status, 200)
      assert.equal(r.headers.get('access-control-allow-origin'), null)
    }
  } finally { await f.close() }
})
test('rejects batches, large bodies and unknown methods', async () => {
  const f = await fixture()
  try {
    assert.equal((await post(f.url, [request])).status, 400)
    assert.equal((await post(f.url, { ...request, method: 'requestAirdrop' })).status, 400)
    assert.equal((await post(f.url, { ...request, params: ['x'.repeat(140000)] })).status, 413)
    assert.equal(f.calls.length, 0)
  } finally { await f.close() }
})
test('bounds aggregate admission without per-client unbounded memory', async () => {
  const f = await fixture({ maxRequests: 1 })
  try {
    assert.equal((await post(f.url)).status, 200)
    const r = await post(f.url); assert.equal(r.status, 429); assert.equal(r.headers.get('retry-after'), '60')
    assert.equal(f.calls.length, 1)
  } finally { await f.close() }
})
test('never retries ambiguous transaction sends and suppresses transport secrets', async () => {
  let calls = 0
  const f = await fixture({ fetchImpl: async () => { calls++; throw new Error('private url ' + key) } })
  try {
    const r = await post(f.url, { ...request, method: 'sendTransaction', params: ['synthetic'] })
    assert.equal(r.status, 502); assert.equal(calls, 1); assert.equal((await r.text()).includes(key), false)
  } finally { await f.close() }
})
test('preserves error codes but removes upstream diagnostic secrets', async () => {
  const f = await fixture({ fetchImpl: async () => Response.json({ jsonrpc: '2.0', id: 1,
    error: { code: -32002, message: key, data: { secret: key } } }) })
  try {
    const r = await post(f.url); const body = await r.text()
    assert.equal(body.includes(key), false); assert.equal(JSON.parse(body).error.code, -32002)
    assert.equal(JSON.parse(body).error.data, undefined)
  } finally { await f.close() }
})
test('redacts unexpected credential occurrences in result payloads', async () => {
  const f = await fixture({ fetchImpl: async () => Response.json({ jsonrpc: '2.0', id: 1, result: key }) })
  try { assert.equal((await (await post(f.url)).text()).includes(key), false) } finally { await f.close() }
})
test('health check does not contact the provider', async () => {
  const f = await fixture()
  try { assert.equal((await fetch(f.url + '/healthz')).status, 200); assert.equal(f.calls.length, 0) } finally { await f.close() }
})
function frame(value, opcode = 1, masked = true) {
  const payload = Buffer.from(JSON.stringify(value)); assert.ok(payload.length < 126)
  const bytes = Buffer.alloc(payload.length + (masked ? 6 : 2)); bytes[0] = 128 | opcode
  bytes[1] = payload.length | (masked ? 128 : 0)
  const mask = Buffer.from([1, 2, 3, 4]); if (masked) mask.copy(bytes, 2)
  for (let i = 0; i < payload.length; i++) bytes[(masked ? 6 : 2) + i] = payload[i] ^ (masked ? mask[i % 4] : 0)
  return bytes
}
async function framesAccepted(chunks, options) {
  const stream = new ClientFrames(options); const result = []
  stream.on('data', b => result.push(b))
  const finished = new Promise(resolve => { stream.on('error', () => resolve(false)); stream.on('finish', () => resolve(true)) })
  for (const chunk of chunks) stream.write(chunk)
  stream.end(); return { accepted: await finished, output: Buffer.concat(result) }
}
test('WebSocket subscription frames survive TCP splitting', async () => {
  const input = frame({ ...request, method: 'slotSubscribe' })
  const r = await framesAccepted([input.subarray(0, 3), input.subarray(3)])
  assert.equal(r.accepted, true); assert.deepEqual(r.output, input)
})
test('WebSocket blocks sends, unmasked, binary and fragmented frames', async () => {
  const fragmented = frame({ ...request, method: 'slotSubscribe' }); fragmented[0] &= 127
  for (const b of [frame({ ...request, method: 'sendTransaction' }), frame(request, 1, false), frame(request, 2), fragmented]) {
    assert.equal((await framesAccepted([b])).accepted, false)
  }
})
test('WebSocket bounds messages per session window', async () => {
  const b = frame({ ...request, method: 'slotSubscribe' })
  assert.equal((await framesAccepted([b, b], { limit: 1 })).accepted, false)
})
