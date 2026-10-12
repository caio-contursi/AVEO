import { describe, expect, it } from 'vitest'
import { localArtifactDirectory, requireLocalEndpoints, requireLocalGenesis } from './localnet-safety'

describe('local signing environment boundaries', () => {
  it.each(['127.0.0.1', 'localhost', '[::1]'])('accepts literal loopback %s', (host) => {
    expect(() => requireLocalEndpoints(`http://${host}:18899`, `ws://${host}:18900`)).not.toThrow()
  })
  it.each([
    'https://api.devnet.solana.com', 'https://api.mainnet-beta.solana.com',
    'http://127.0.0.1.example.com', 'http://user:secret@127.0.0.1',
    'http://127.0.0.1/proxy', 'http://127.0.0.1?cluster=devnet',
    'http://127.0.0.1#remote', 'not-a-url',
    'http://127.1/', 'http://2130706433/', 'http://0x7f000001/',
  ])('rejects RPC %s without accessing the network', (url) => {
    expect(() => requireLocalEndpoints(url, 'ws://127.0.0.1:18900')).toThrow()
  })
  it('also rejects remote websocket endpoints', () => {
    expect(() => requireLocalEndpoints('http://127.0.0.1:18899', 'wss://api.devnet.solana.com')).toThrow()
  })
  it('retains the default local directory and accepts an isolated absolute directory', () => {
    expect(localArtifactDirectory('/app')).toBe('/app/.dev')
    expect(localArtifactDirectory('/app', '/tmp/aveo-isolated/artifacts')).toBe('/tmp/aveo-isolated/artifacts')
  })
  it.each(['', ' ', 'relative', '/'])('rejects ambiguous directory %s', (value) => {
    expect(() => localArtifactDirectory('/app', value)).toThrow()
  })
  it.each([
    'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY', 'invalid',
  ])('rejects public or invalid validator identity %s', (genesis) => {
    expect(() => requireLocalGenesis(genesis)).toThrow()
  })
  it('pins the isolated validator identity even behind a loopback proxy', () => {
    const genesis = '4nfcdrcw57kgy95FkeDLZ5aVcjMThnMpW1acN1gsmZyF'
    expect(() => requireLocalGenesis(genesis, genesis)).not.toThrow()
    expect(() => requireLocalGenesis(genesis, 'another-validator')).toThrow()
  })
})
