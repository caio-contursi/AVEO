import { afterEach, describe, expect, it, vi } from 'vitest'
import { localIntentRead } from './local-intent-read'

vi.mock('./lib', () => { throw new Error('Fixture library must not load in read tests') })

const rpcUrl = 'http://127.0.0.1:18899'
const encoder = new TextEncoder()
const failure = 'Local intent read failed.'
const encodeResult = (result: unknown) => encoder.encode(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))

function streamingResponse(chunks: Uint8Array[], headers?: HeadersInit) {
  const cancel = vi.fn()
  let index = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++]!)
      else controller.close()
    }, cancel,
  })
  return { response: new Response(stream, { headers }), cancel }
}

function mockFetch(response: Response) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('bounded local intent reads', () => {
  it.each(['getGenesisHash', 'getTransaction'] as const)('allows only a literal loopback %s POST', async (method) => {
    const result = { text: 'ação', slot: 42 }
    const bytes = encodeResult(result)
    const fetchMock = mockFetch(streamingResponse(Array.from(bytes, (byte) => Uint8Array.of(byte))).response)
    await expect(localIntentRead(rpcUrl, method, ['signature', { encoding: 'base64' }])).resolves.toEqual(result)
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(rpcUrl, {
      method: 'POST', redirect: 'error', signal: expect.any(AbortSignal),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: ['signature', { encoding: 'base64' }] }),
    })
  })

  it('accepts literal IPv6 loopback and a null result', async () => {
    mockFetch(streamingResponse([encodeResult(null)]).response)
    await expect(localIntentRead('http://[::1]:18899', 'getTransaction', [])).resolves.toBeNull()
  })

  it.each(['http://localhost:18899', 'http://2130706433:18899', 'https://api.devnet.solana.com',
    'http://private:secret@127.0.0.1:18899', `${rpcUrl}?secret=private`, `${rpcUrl}/proxy`])(
    'rejects unsafe endpoint %s before fetch', async (endpoint) => {
      const fetchMock = mockFetch(streamingResponse([encodeResult(null)]).response)
      await expect(localIntentRead(endpoint, 'getGenesisHash', [])).rejects.toThrow(failure)
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  it.each(['sendTransaction', 'getSignatureStatuses', 'getBalance', 'constructor'])(
    'rejects runtime method %s before fetch', async (method) => {
      const fetchMock = mockFetch(streamingResponse([encodeResult(null)]).response)
      await expect(localIntentRead(rpcUrl, method as 'getTransaction', [])).rejects.toThrow(failure)
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  it('accepts exactly 32768 raw bytes', async () => {
    const prefix = '{"jsonrpc":"2.0","id":1,"result":"'
    const suffix = '"}'
    const text = 'x'.repeat(32_768 - prefix.length - suffix.length)
    const bytes = encoder.encode(prefix + text + suffix)
    mockFetch(streamingResponse([bytes.subarray(0, 100), bytes.subarray(100)], { 'Content-Length': '32768' }).response)
    await expect(localIntentRead(rpcUrl, 'getTransaction', [])).resolves.toBe(text)
  })

  it.each(['32769', '999999999999999999999999999999', '-1', 'invalid'])(
    'rejects Content-Length %s before reading or decoding', async (length) => {
      const f = streamingResponse([encodeResult(null)], { 'Content-Length': length })
      const read = vi.spyOn(ReadableStreamDefaultReader.prototype, 'read')
      const decode = vi.spyOn(TextDecoder.prototype, 'decode')
      mockFetch(f.response)
      await expect(localIntentRead(rpcUrl, 'getTransaction', [])).rejects.toThrow(failure)
      expect(read).not.toHaveBeenCalled()
      expect(decode).not.toHaveBeenCalled()
      expect(f.cancel).toHaveBeenCalledOnce()
    },
  )

  it.each([undefined, '1'])('rejects streamed overflow with Content-Length %s before decoding', async (length) => {
    const f = streamingResponse([new Uint8Array(32_768), Uint8Array.of(1), Uint8Array.of(2)],
      length === undefined ? undefined : { 'Content-Length': length })
    const decode = vi.spyOn(TextDecoder.prototype, 'decode')
    mockFetch(f.response)
    await expect(localIntentRead(rpcUrl, 'getTransaction', [])).rejects.toThrow(failure)
    expect(decode).not.toHaveBeenCalled()
    expect(f.cancel).toHaveBeenCalledOnce()
  })

  it('counts UTF-8 bytes rather than characters', async () => {
    const decode = vi.spyOn(TextDecoder.prototype, 'decode')
    mockFetch(streamingResponse([encodeResult('é'.repeat(16_384))]).response)
    await expect(localIntentRead(rpcUrl, 'getTransaction', [])).rejects.toThrow(failure)
    expect(decode).not.toHaveBeenCalled()
  })

  it('rejects a single oversized chunk before decoding', async () => {
    const decode = vi.spyOn(TextDecoder.prototype, 'decode')
    mockFetch(streamingResponse([new Uint8Array(32_769)]).response)
    await expect(localIntentRead(rpcUrl, 'getTransaction', [])).rejects.toThrow(failure)
    expect(decode).not.toHaveBeenCalled()
  })

  it.each([
    'private invalid JSON', 'null', '[]', '{}',
    '{"jsonrpc":"1.0","id":1,"result":null}', '{"jsonrpc":"2.0","id":"1","result":null}',
    '{"jsonrpc":"2.0","id":2,"result":null}', '{"jsonrpc":"2.0","result":null}',
    '{"jsonrpc":"2.0","id":1}', '{"jsonrpc":"2.0","id":1,"error":{"message":"private"}}',
    '{"jsonrpc":"2.0","id":1,"result":null,"error":null}',
  ])('rejects malformed or error envelope %s with a sanitized error', async (body) => {
    mockFetch(streamingResponse([encoder.encode(body)]).response)
    await expect(localIntentRead(rpcUrl, 'getTransaction', [])).rejects.toThrow(new Error(failure))
  })

  it('rejects invalid UTF-8 even inside otherwise valid JSON', async () => {
    mockFetch(streamingResponse([encoder.encode('{"jsonrpc":"2.0","id":1,"result":"'),
      Uint8Array.of(0xc3, 0x28), encoder.encode('"}')]).response)
    await expect(localIntentRead(rpcUrl, 'getTransaction', [])).rejects.toThrow(failure)
  })

  it.each([302, 500])('rejects HTTP status %s', async (status) => {
    mockFetch(new Response(encodeResult(null), { status }))
    await expect(localIntentRead(rpcUrl, 'getGenesisHash', [])).rejects.toThrow(failure)
  })

  it('rejects an absent body', async () => {
    mockFetch(new Response(null))
    await expect(localIntentRead(rpcUrl, 'getGenesisHash', [])).rejects.toThrow(failure)
  })

  it('sanitizes fetch and stream failures', async () => {
    const fetchMock = mockFetch(new Response(new ReadableStream({
      start(controller) { controller.error(new Error('private response payload')) },
    })))
    await expect(localIntentRead(rpcUrl, 'getTransaction', [])).rejects.toThrow(new Error(failure))
    fetchMock.mockRejectedValue(new Error('private endpoint credentials'))
    await expect(localIntentRead(rpcUrl, 'getTransaction', [])).rejects.toThrow(new Error(failure))
  })

  it.each(['fetch', 'body'] as const)('bounds a hanging %s at 10000ms and aborts the request', async (stage) => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    const response = new Response(new ReadableStream({ cancel }))
    const fetchMock = mockFetch(response)
    if (stage === 'fetch') fetchMock.mockImplementation(() => new Promise(() => {}))
    const failed = expect(localIntentRead(rpcUrl, 'getTransaction', [])).rejects.toThrow(failure)
    await vi.advanceTimersByTimeAsync(9_999)
    const signal = fetchMock.mock.calls[0]![1]!.signal!
    expect(signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await failed
    expect(signal.aborted).toBe(true)
    expect(cancel).toHaveBeenCalledTimes(stage === 'body' ? 1 : 0)
  })

  it('shares the deadline across fetch and body and clears its timer afterward', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    const response = new Response(new ReadableStream({ cancel }))
    const fetchMock = mockFetch(response)
    fetchMock.mockImplementation(() => new Promise((resolve) => { setTimeout(() => resolve(response), 6_000) }))
    const failed = expect(localIntentRead(rpcUrl, 'getTransaction', [])).rejects.toThrow(failure)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(cancel).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await failed
    expect(cancel).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears the deadline after a successful read', async () => {
    vi.useFakeTimers()
    const fetchMock = mockFetch(streamingResponse([encodeResult('genesis')]).response)
    await expect(localIntentRead(rpcUrl, 'getGenesisHash', [])).resolves.toBe('genesis')
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetchMock.mock.calls[0]![1]!.signal!.aborted).toBe(false)
  })
})
