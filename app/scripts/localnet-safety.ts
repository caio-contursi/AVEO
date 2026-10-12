import path from 'node:path'

const PUBLIC_GENESIS_HASHES = [
  'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
]

export function requireLocalGenesis(actual: string, expected?: string): void {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(actual) || PUBLIC_GENESIS_HASHES.includes(actual)
    || (expected !== undefined && actual !== expected)) {
    throw new Error('Validator identity is not the approved local network')
  }
}

export function requireLocalEndpoints(rpcUrl: string, wsUrl: string): void {
  for (const [endpoint, protocol] of [[rpcUrl, 'http:'], [wsUrl, 'ws:']]) {
    if (!/^(?:http|ws):\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?(?:\/|$)/.test(endpoint)) {
      throw new Error('Local scripts require literal loopback endpoints')
    }
    let url: URL
    try { url = new URL(endpoint) } catch { throw new Error('Local scripts require explicit loopback endpoints') }
    if (url.protocol !== protocol || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('Local scripts forbid public networks, authenticated URLs and proxy paths')
    }
  }
}

/** Isolated runs select an absolute artifact directory; ordinary local usage stays unchanged. */
export function localArtifactDirectory(appRoot: string, configured?: string): string {
  if (configured === undefined) return path.join(appRoot, '.dev')
  if (!configured.trim() || !path.isAbsolute(configured) || path.parse(configured).root === path.resolve(configured)) {
    throw new Error('AVEO_DEV_DIR must be an explicit absolute non-root directory')
  }
  return path.resolve(configured)
}
