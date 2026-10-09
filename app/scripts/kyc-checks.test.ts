import { getAddressDecoder, type Address } from '@solana/kit'
import { describe, expect, it } from 'vitest'
import { AVEO_HOOK_PROGRAM_ID, SAS_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '../src/api/constants'
import type { ApiContext } from '../src/api/context'
import type { DeskSnapshot, DiagnosticReason } from '../src/api/diagnostics'
import type { Deployment } from '../src/config/deployment'
import { requireFalseKycSnapshots } from './kyc-checks'

const addr = (byte: number): Address => getAddressDecoder().decode(new Uint8Array(32).fill(byte))
const FAILURE = 'False KYC observations could not be verified'
const NOW = '2026-10-09T12:00:00.000Z'
const owner = addr(1), proof = addr(2)
const deployment: Deployment = {
  version: 1, cluster: 'localnet', generatedAt: NOW,
  programs: { aveoHook: AVEO_HOOK_PROGRAM_ID, sas: SAS_PROGRAM_ID, token2022: TOKEN_2022_PROGRAM_ID },
  proofDomain: 'a'.repeat(64), issuer: addr(3),
  verifiers: [{ id: 'issuer', label: 'Issuer', authority: addr(3), credential: addr(4), schema: addr(5) }],
  assets: [{ id: 'alfa', label: 'Alfa', symbol: 'ALFA', mint: addr(6), decimals: 0 },
    { id: 'beta', label: 'Beta', symbol: 'BETA', mint: addr(7), decimals: 0 }],
  wallets: [{ id: 'X', label: 'X', address: owner, role: 'investor' }],
}

interface Fixture {
  ctx: ApiContext
  snapshots: [DeskSnapshot, DeskSnapshot]
  owner: Address
  proof: Address
  assets: { mint: Address }[]
  floor: number
}

function fixture(): Fixture {
  // Synthetic typed observations only; these inputs do not establish ledger rejection.
  // A throwing RPC double ensures this synchronous helper cannot perform any RPC operation.
  const rpc = new Proxy({} as ApiContext['rpc'], {
    get() { throw new Error('Unit helper must not access RPC') },
  })
  const ctx: ApiContext = { cluster: 'localnet', rpcUrl: 'http://127.0.0.1:8899',
    commitment: 'confirmed', programId: AVEO_HOOK_PROGRAM_ID, deployment, rpc }
  const snapshot = (mint: Address, slot: number): DeskSnapshot => ({
    backend: 'aveo-sas-hook', mint, wallet: owner, verdict: 'ineligible', policyVersion: 1n,
    read: { cluster: ctx.cluster, rpcUrl: ctx.rpcUrl, commitment: ctx.commitment, slot, observedAt: NOW },
    reasons: [{ code: 'RequiredFactMissing', message: 'Synthetic KYC failure', params: { fact: 'kyc' } }],
    actions: [], sourceAccounts: { attestation: proof }, clockUnix: 100,
    proof: { attestation: proof, credential: addr(4), schema: addr(5), signer: addr(3),
      expiry: 101n, kycPass: false, accreditedPass: true },
  })
  return { ctx, snapshots: [snapshot(addr(6), 42), snapshot(addr(7), 43)], owner, proof,
    assets: deployment.assets.map(({ mint }) => ({ mint })), floor: 42 }
}

describe('false KYC snapshot validation with synthetic unit observations', () => {
  it('accepts two matching distinct mints at or above the floor with one second before expiry', () => {
    const input = fixture()
    const original = structuredClone({ ...input, ctx: { ...input.ctx, rpc: undefined } })
    expect(requireFalseKycSnapshots(input)).toBeUndefined()
    expect({ ...input, ctx: { ...input.ctx, rpc: undefined } }).toEqual(original)
  })

  it('matches mints independently of snapshot order and accepts explanatory hints', () => {
    const input = fixture()
    input.snapshots.reverse()
    input.snapshots[0].reasons.unshift({ code: 'AttestationExpired', message: 'Synthetic hint', hint: true })
    input.snapshots[1].reasons.push({ code: 'RequiredFactMissing', message: 'Synthetic hint', hint: true,
      params: { fact: 'accredited' } })
    expect(() => requireFalseKycSnapshots(input)).not.toThrow()
  })

  it.each(['http://localhost:8899/', 'https://127.0.0.1:8899/', 'http://[::1]:8899/'])(
    'accepts credential-free literal loopback roots: %s', (rpcUrl) => {
    const input = fixture()
    input.ctx.rpcUrl = rpcUrl
    input.snapshots.forEach((snapshot) => { snapshot.read.rpcUrl = rpcUrl })
    expect(() => requireFalseKycSnapshots(input)).not.toThrow()
  })

  it('accepts finalized evidence when both observations match that commitment', () => {
    const input = fixture()
    input.ctx.commitment = 'finalized'
    input.snapshots.forEach((snapshot) => { snapshot.read.commitment = 'finalized' })
    expect(() => requireFalseKycSnapshots(input)).not.toThrow()
  })

  const invalidInputs: [string, (input: Fixture) => void][] = [
    ['no assets', (input) => { input.assets = [] }],
    ['only one asset', (input) => { input.assets.pop() }],
    ['three assets', (input) => { input.assets.push({ mint: addr(8) }) }],
    ['duplicate asset mints', (input) => { input.assets[1] = input.assets[0]! }],
    ['no snapshots', (input) => { input.snapshots.splice(0) }],
    ['only one snapshot', (input) => { input.snapshots.pop() }],
    ['three snapshots', (input) => { input.snapshots.push(input.snapshots[0]) }],
    ['duplicate snapshot mints', (input) => { input.snapshots[1].mint = input.snapshots[0].mint }],
    ['wrong expected owner', (input) => { input.owner = addr(8) }],
    ['wrong expected proof', (input) => { input.proof = addr(8) }],
    ['wrong program', (input) => { input.ctx.programId = addr(8) }],
    ['matching external cluster', (input) => {
      input.ctx.cluster = 'devnet'
      input.snapshots.forEach((snapshot) => { snapshot.read.cluster = 'devnet' })
    }],
    ['matching processed commitment', (input) => {
      input.ctx.commitment = 'processed'
      input.snapshots.forEach((snapshot) => { snapshot.read.commitment = 'processed' })
    }],
    ...[0, -1, 42.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((floor): [string, (input: Fixture) => void] =>
      [`invalid floor ${floor}`, (input) => { input.floor = floor }]),
    ...['https://api.devnet.solana.com', 'http://127.0.0.2:8899', 'http://localhost.example:8899',
      'http://user:password@127.0.0.1:8899', 'http://user@localhost:8899', 'http://localhost:8899/path',
      'http://localhost:8899/?token=synthetic', 'http://localhost:8899/#synthetic',
      'ftp://localhost:8899/', 'not a URL'].map((rpcUrl): [string, (input: Fixture) => void] =>
      [`unsafe endpoint ${rpcUrl}`, (input) => {
        input.ctx.rpcUrl = rpcUrl
        input.snapshots.forEach((snapshot) => { snapshot.read.rpcUrl = rpcUrl })
      }]),
  ]
  it.each(invalidInputs)('rejects %s with the exact static error', (_name, mutate) => {
    const input = fixture()
    mutate(input)
    expect(() => requireFalseKycSnapshots(input)).toThrow(new Error(FAILURE))
  })

  const invalidSnapshots: [string, (snapshot: DeskSnapshot) => void][] = [
    ['unknown verdict', (snapshot) => { snapshot.verdict = 'unknown' }],
    ['eligible verdict', (snapshot) => { snapshot.verdict = 'eligible' }],
    ['wrong owner', (snapshot) => { snapshot.wallet = addr(8) }],
    ['wrong mint', (snapshot) => { snapshot.mint = addr(8) }],
    ['wrong backend', (snapshot) => { snapshot.backend = 'mpl3643' }],
    ['wrong cluster', (snapshot) => { snapshot.read.cluster = 'devnet' }],
    ['wrong RPC', (snapshot) => { snapshot.read.rpcUrl = 'http://localhost:8899' }],
    ['wrong commitment', (snapshot) => { snapshot.read.commitment = 'finalized' }],
    ['missing bound proof', (snapshot) => { delete snapshot.sourceAccounts.attestation }],
    ['wrong bound proof', (snapshot) => { snapshot.sourceAccounts.attestation = addr(8) }],
    ['missing parsed proof', (snapshot) => { delete snapshot.proof }],
    ['wrong parsed proof', (snapshot) => { snapshot.proof!.attestation = addr(8) }],
    ['different shared proof', (snapshot) => {
      snapshot.sourceAccounts.attestation = addr(8)
      snapshot.proof!.attestation = addr(8)
    }],
    ['KYC true', (snapshot) => { snapshot.proof!.kycPass = true }],
    ['missing KYC fact', (snapshot) => { Reflect.deleteProperty(snapshot.proof!, 'kycPass') }],
    ['accredited false', (snapshot) => { snapshot.proof!.accreditedPass = false }],
    ['missing accredited fact', (snapshot) => { Reflect.deleteProperty(snapshot.proof!, 'accreditedPass') }],
    ['missing Clock', (snapshot) => { delete snapshot.clockUnix }],
    ['expiry equal to Clock', (snapshot) => { snapshot.proof!.expiry = 100n }],
    ['expired proof', (snapshot) => { snapshot.proof!.expiry = 99n }],
    ['no primary reason', (snapshot) => { snapshot.reasons = [] }],
    ['only hinted KYC reason', (snapshot) => { snapshot.reasons[0]!.hint = true }],
    ['missing fact parameters', (snapshot) => { delete snapshot.reasons[0]!.params }],
    ['missing fact name', (snapshot) => { snapshot.reasons[0]!.params = {} }],
    ['different fact', (snapshot) => { snapshot.reasons[0]!.params = { fact: 'accredited' } }],
    ['duplicate primary KYC reason', (snapshot) => { snapshot.reasons.push({ ...snapshot.reasons[0]! }) }],
    ...(['AttestationExpired', 'AttestationMissingOrClosed', 'ProviderPairNotAllowed'] satisfies DiagnosticReason['code'][])
      .flatMap((code): [string, (snapshot: DeskSnapshot) => void][] => [
        [`wrong primary error ${code}`, (snapshot) => { snapshot.reasons[0]!.code = code }],
        [`secondary primary error ${code}`, (snapshot) => {
          snapshot.reasons.push({ code, message: 'Synthetic unrelated primary failure' })
        }],
      ]),
    ...[41, -1, 42.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((slot): [string, (snapshot: DeskSnapshot) => void] =>
      [`stale or unsafe slot ${slot}`, (snapshot) => { snapshot.read.slot = slot }]),
    ...[-1, 100.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((clock): [string, (snapshot: DeskSnapshot) => void] =>
      [`unsafe Clock ${clock}`, (snapshot) => { snapshot.clockUnix = clock }]),
  ]
  describe.each([0, 1] as const)('snapshot %i must independently satisfy every guard', (index) => {
    it.each(invalidSnapshots)('rejects %s with the exact static error', (_name, mutate) => {
      const input = fixture()
      mutate(input.snapshots[index])
      expect(() => requireFalseKycSnapshots(input)).toThrow(new Error(FAILURE))
    })
  })

  it('accepts Clock zero and preserves bigint expiry above the safe number range', () => {
    const input = fixture()
    input.snapshots[0].clockUnix = 0
    input.snapshots[0].proof!.expiry = 1n
    input.snapshots[1].proof!.expiry = 9007199254740993n
    expect(() => requireFalseKycSnapshots(input)).not.toThrow()
  })
})
