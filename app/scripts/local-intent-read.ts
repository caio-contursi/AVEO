import { bounded, validateLocalEndpoints } from './local-recovery-check'

const MAX_RESPONSE_BYTES = 32_768

/** Read-only local RPC with bounded transport, body size and decoding. */
export async function localIntentRead(rpcUrl: string, method: 'getGenesisHash' | 'getTransaction', params: unknown[]): Promise<unknown> {
  try {
    validateLocalEndpoints('localnet', rpcUrl, 'ws://127.0.0.1:8900')
    if (method !== 'getGenesisHash' && method !== 'getTransaction') throw new Error()
    return await bounded(async (signal) => {
      const response = await fetch(rpcUrl, {
        method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      })
      if (signal.aborted || !response.ok || !response.body) throw new Error()
      const reader = response.body.getReader()
      const cancel = () => { void reader.cancel().catch(() => {}) }
      signal.addEventListener('abort', cancel, { once: true })
      try {
        const contentLength = response.headers.get('content-length')
        if (contentLength !== null && (!/^\d+$/.test(contentLength) || BigInt(contentLength) > BigInt(MAX_RESPONSE_BYTES))) {
          throw new Error()
        }
        const bytes = new Uint8Array(MAX_RESPONSE_BYTES)
        let length = 0
        while (true) {
          const { done, value } = await reader.read()
          if (signal.aborted) throw new Error()
          if (done) break
          if (value.byteLength > MAX_RESPONSE_BYTES - length) throw new Error()
          bytes.set(value, length)
          length += value.byteLength
        }
        const envelope: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)))
        if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
          !('jsonrpc' in envelope) || envelope.jsonrpc !== '2.0' ||
          !('id' in envelope) || envelope.id !== 1 || 'error' in envelope || !('result' in envelope)) throw new Error()
        return envelope.result
      } finally {
        signal.removeEventListener('abort', cancel)
        cancel()
        reader.releaseLock()
      }
    }, 10_000)
  } catch { throw new Error('Local intent read failed.') }
}
