import { getAddressDecoder } from '@solana/kit'
import { describe, expect, it } from 'vitest'
import { parseEnv } from './env'

describe('application environment', () => {
  it('defaults to localnet with development wallets disabled', () => {
    expect(parseEnv({})).toEqual({
      ok: true,
      env: {
        VITE_CLUSTER: 'localnet',
        VITE_RPC_URL: 'http://127.0.0.1:8899',
        VITE_COMMITMENT: 'confirmed',
        VITE_DEPLOYMENT_URL: '/dev/deployment.json',
        VITE_BACKEND: 'aveo-sas-hook',
        VITE_ENABLE_DEV_WALLETS: false,
      },
    })
  })

  it('uses defaults for empty values supplied by Vite', () => {
    expect(parseEnv({ VITE_CLUSTER: '', VITE_RPC_URL: '', VITE_AVEO_PROGRAM_ID: '', VITE_DEPLOYMENT_URL: '' }))
      .toEqual(parseEnv({ VITE_AVEO_PROGRAM_ID: undefined }))
  })

  it.each(['', '   ', undefined])('accepts a blank program override (%s) for the default program', (value) => {
    const result = parseEnv({ VITE_AVEO_PROGRAM_ID: value })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.env.VITE_AVEO_PROGRAM_ID).toBeFalsy()
  })

  it.each(['invalid-address', '0'.repeat(32), '1'.repeat(31), '1'.repeat(33), ' invalid-address '])(
    'returns a configuration issue for malformed program override %s',
    (value) => {
      expect(parseEnv({ VITE_AVEO_PROGRAM_ID: value })).toEqual({
        ok: false,
        issues: ['VITE_AVEO_PROGRAM_ID: Invalid Solana program address'],
      })
    },
  )

  it('preserves an explicitly selected devnet environment and trims the program and manifest URL', () => {
    const programId = getAddressDecoder().decode(new Uint8Array(32).fill(7))
    const result = parseEnv({
      VITE_CLUSTER: 'devnet',
      VITE_RPC_URL: 'https://api.devnet.solana.com',
      VITE_COMMITMENT: 'finalized',
      VITE_AVEO_PROGRAM_ID: ` ${programId} `,
      VITE_DEPLOYMENT_URL: ' /deployment.devnet.json ',
      VITE_ENABLE_DEV_WALLETS: 'true',
    })
    expect(result).toMatchObject({
      ok: true,
      env: {
        VITE_CLUSTER: 'devnet',
        VITE_RPC_URL: 'https://api.devnet.solana.com',
        VITE_COMMITMENT: 'finalized',
        VITE_AVEO_PROGRAM_ID: programId,
        VITE_DEPLOYMENT_URL: '/deployment.devnet.json',
        VITE_ENABLE_DEV_WALLETS: true,
      },
    })
  })

  it.each([
    ['VITE_CLUSTER', 'mainnet-beta'],
    ['VITE_RPC_URL', 'not-a-url'],
    ['VITE_COMMITMENT', 'unknown'],
    ['VITE_DEPLOYMENT_URL', '   '],
    ['VITE_BACKEND', 'unknown'],
    ['VITE_ENABLE_DEV_WALLETS', 'yes'],
    ['VITE_ENABLE_DEV_WALLETS', true],
  ])('reports invalid %s without throwing', (key, value) => {
    const result = parseEnv({ [key]: value })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.some((issue) => issue.startsWith(`${key}:`))).toBe(true)
  })
})
