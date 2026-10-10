import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Address, KeyPairSigner, Signature } from '@solana/kit'
import type { ApiContext } from '../src/api/context'
import type { DeskPlan } from '../src/api/backend'
import type { DeskSnapshot } from '../src/api/diagnostics'
import type { Deployment } from '../src/config/deployment'
import { AVEO_HOOK_PROGRAM_ID } from '../src/api/constants'
import {
  bounded, RecoveryCheckError, runLocalRecoveryCheck, unavailableConfirmationContext,
  validateFixtureDirectory, validateLocalEndpoints, type RecoveryEvidence,
} from './local-recovery-check'

// Importing helpers must never import the fixture loader or read app/.dev.
vi.mock('./lib', () => { throw new Error('Fixture library must not load in helper tests') })

const addr = (n: number) => `${'1'.repeat(31)}${n}` as Address
const signature = 'synthetic-test-signature' as Signature
const rpcUrl = 'http://127.0.0.1:18899'
const wsUrl = 'ws://127.0.0.1:18900'
const hookSuccess = `Program ${AVEO_HOOK_PROGRAM_ID} success`

function fixture() {
  const deployment = {
    cluster: 'localnet', generatedAt: '2026-10-10T12:00:00Z', programs: { aveoHook: AVEO_HOOK_PROGRAM_ID },
    assets: [{ id: 'alfa', mint: addr(2), decimals: 0 }],
    wallets: [{ id: 'X', role: 'investor', address: addr(3) }, { id: 'treasury', role: 'treasury', address: addr(4) }],
  } as Deployment
  const statusSend = vi.fn(async () => ({ value: [{ slot: 42n, err: null, confirmationStatus: 'confirmed' }] }))
  const transactionSend = vi.fn(async () => ({ meta: { logMessages: [hookSuccess] } }))
  const rawSend = vi.fn(async () => signature)
  const sendTransaction = vi.fn(() => ({ send: rawSend }))
  const ctx = { cluster: 'localnet', rpcUrl, commitment: 'confirmed', programId: AVEO_HOOK_PROGRAM_ID, deployment,
    rpc: { getSignatureStatuses: vi.fn(() => ({ send: statusSend })),
      getTransaction: vi.fn(() => ({ send: transactionSend })), sendTransaction },
  } as unknown as ApiContext
  const snapshot = (wallet: Address): DeskSnapshot => ({ backend: 'aveo-sas-hook', mint: addr(2), wallet, verdict: 'eligible',
    reasons: [], actions: [],
    read: { cluster: 'localnet', rpcUrl, commitment: 'confirmed', slot: 40, observedAt: deployment.generatedAt },
    sourceAccounts: { attestation: addr(5) }, proof: { attestation: addr(5), expiry: 1300n,
      credential: addr(6), schema: addr(7), signer: addr(8), kycPass: true, accreditedPass: true }, clockUnix: 1000 })
  const plan: DeskPlan = { backend: 'aveo-sas-hook', transaction: 'unsigned-mock', summary: [],
    requiredSigners: [addr(3)], simulation: { ok: true, logs: [] },
    request: { kind: 'transfer', mint: addr(2), sourceOwner: addr(3), destinationOwner: addr(4), amount: 1n, decimals: 0 },
    diagnostics: { source: snapshot(addr(3)), destination: snapshot(addr(4)) },
  }
  const dependencies = {
    plan: vi.fn(async () => plan),
    sign: vi.fn(async () => ({ signature, wire: 'mock-wire-no-keys' as ReturnType<typeof import('@solana/kit').getBase64EncodedWireTransaction> })),
    balances: vi.fn().mockResolvedValueOnce({ slot: 40, balances: [5n, 8n] })
      .mockResolvedValueOnce({ slot: 43, balances: [4n, 9n] }),
  }
  const verifyLocalValidator = vi.fn(async () => {})
  const records: RecoveryEvidence[] = []
  const persist = vi.fn((evidence: RecoveryEvidence) => { records.push(evidence) })
  const input = { ctx, wsUrl, generatedX: { address: addr(3) } as KeyPairSigner, verifyLocalValidator,
    dependencies, persist, faultTimeoutMs: 5, recoveryTimeoutMs: 50 }
  return { input, plan, dependencies, records, persist, verifyLocalValidator, statusSend, transactionSend, rawSend, sendTransaction }
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('local recovery acceptance', () => {
  it.each(['hanging', 'unavailable'] as const)('checks the mocked recovery lifecycle after %s confirmation reads with one sign and submission', async (faultMode) => {
    const f = fixture()
    f.rawSend.mockImplementation(async () => {
      expect(f.records[0]).toMatchObject({ signature, status: 'pending', submissions: 0 })
      expect(f.verifyLocalValidator).toHaveBeenCalledTimes(2)
      return signature
    })
    const result = await runLocalRecoveryCheck({ ...f.input, faultMode })
    expect(result).toMatchObject({ status: 'PASS', signature, signatures: 1, submissions: 1,
      before: ['5', '8'], after: ['4', '9'], confirmationSlot: 42, balanceSlot: 43, hookSuccess })
    expect(f.records.map((record) => record.status)).toEqual(['pending', 'pending', 'unknown', 'PASS'])
    expect(result.confirmationReadFaults).toBeGreaterThan(0)
    expect(f.dependencies.sign).toHaveBeenCalledOnce()
    expect(f.sendTransaction).toHaveBeenCalledExactlyOnceWith('mock-wire-no-keys', {
      encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0n,
    })
    expect(f.statusSend).toHaveBeenCalledOnce()
    expect(f.transactionSend).toHaveBeenCalledOnce()
    expect(f.dependencies.balances.mock.calls[1]?.[3]).toBe(42)
    expect(JSON.stringify(result)).not.toMatch(/secretKey|mock-wire|credentials/)
  })

  it('clones only confirmation reads and preserves send identity and the real context', async () => {
    const f = fixture()
    const fault = unavailableConfirmationContext(f.input.ctx, 'unavailable')
    expect(fault.ctx).not.toBe(f.input.ctx)
    expect(fault.ctx.rpc.sendTransaction).toBe(f.input.ctx.rpc.sendTransaction)
    await expect(fault.ctx.rpc.getTransaction(signature).send()).rejects.toThrow(RecoveryCheckError)
    expect(fault.counters).toEqual({ statuses: 0, transactions: 1 })
    expect(f.transactionSend).not.toHaveBeenCalled()
    await f.input.ctx.rpc.getTransaction(signature).send()
    expect(f.transactionSend).toHaveBeenCalledOnce()
  })

  it.each(['expired', 'ineligible', 'simulation', 'wrong-owner', 'wrong-signer', 'stale', 'unbounded'])(
    'blocks %s before signing or sending', async (failure) => {
      const f = fixture()
      if (failure === 'expired') f.plan.diagnostics.source.proof!.expiry = 999n
      if (failure === 'ineligible') f.plan.diagnostics.destination.verdict = 'unknown'
      if (failure === 'simulation') f.plan.simulation.ok = false
      if (failure === 'wrong-owner' && f.plan.request.kind === 'transfer') f.plan.request.sourceOwner = addr(8)
      if (failure === 'wrong-signer') f.input.generatedX = { address: addr(8) } as KeyPairSigner
      if (failure === 'stale') f.dependencies.balances.mockReset().mockResolvedValue({ slot: 39, balances: [5n, 8n] })
      if (failure === 'unbounded') f.input.recoveryTimeoutMs = 1_000_000
      await expect(runLocalRecoveryCheck(f.input)).rejects.toThrow(RecoveryCheckError)
      expect(f.dependencies.sign).not.toHaveBeenCalled()
      expect(f.sendTransaction).not.toHaveBeenCalled()
    },
  )

  it('blocks a validator identity mismatch before signing', async () => {
    const f = fixture()
    f.verifyLocalValidator.mockRejectedValue(new Error('https://private:credential@example.test'))
    await expect(runLocalRecoveryCheck(f.input)).rejects.toThrow(new RecoveryCheckError().message)
    expect(f.dependencies.sign).not.toHaveBeenCalled()
    expect(f.sendTransaction).not.toHaveBeenCalled()
  })

  it.each(['no-hook', 'wrong-delta', 'stale-read', 'failed-ledger', 'send-error', 'signature-mismatch', 'persist-error', 'hanging-recovery', 'hanging-logs'])(
    'fails safely on %s without any resend or recovery signature', async (failure) => {
      const f = fixture()
      if (failure === 'no-hook') f.transactionSend.mockResolvedValue({ meta: { logMessages: [] } })
      if (failure === 'wrong-delta' || failure === 'stale-read') {
        f.dependencies.balances.mockReset().mockResolvedValueOnce({ slot: 40, balances: [5n, 8n] })
          .mockResolvedValueOnce({ slot: failure === 'stale-read' ? 41 : 43, balances: [3n, 10n] })
      }
      if (failure === 'failed-ledger') f.statusSend.mockResolvedValue({ value: [{ slot: 42n,
        err: { InstructionError: [0, 'InvalidArgument'] }, confirmationStatus: 'confirmed' }] } as never)
      if (failure === 'send-error') f.rawSend.mockRejectedValue(new Error('raw credential must never escape'))
      if (failure === 'signature-mismatch') f.rawSend.mockResolvedValue('other-signature' as Signature)
      if (failure === 'persist-error') f.persist.mockImplementation(() => { throw new Error('credential') })
      if (failure === 'hanging-recovery') f.statusSend.mockImplementation(() => new Promise(() => {}))
      if (failure === 'hanging-logs') f.transactionSend.mockImplementation(() => new Promise(() => {}))
      await expect(runLocalRecoveryCheck(f.input)).rejects.toThrow(new RecoveryCheckError().message)
      expect(f.dependencies.sign).toHaveBeenCalledOnce()
      expect(f.sendTransaction).toHaveBeenCalledTimes(failure === 'persist-error' ? 0 : 1)
      expect(f.records.every((record) => record.status !== 'PASS')).toBe(true)
    },
  )

  it('bounds a hanging operation and aborts its signal', async () => {
    let signal: AbortSignal | undefined
    await expect(bounded((received) => { signal = received; return new Promise(() => {}) }, 5)).rejects.toThrow(RecoveryCheckError)
    expect(signal?.aborted).toBe(true)
  })
})

describe('local scope guards', () => {
  it('accepts explicit IPv4/IPv6 loopback and isolated ports', () => {
    validateLocalEndpoints('localnet', rpcUrl, wsUrl)
    validateLocalEndpoints('localnet', 'http://[::1]:18899', 'ws://[::1]:18900')
  })
  it.each([
    ['devnet', rpcUrl, wsUrl], ['mainnet-beta', rpcUrl, wsUrl],
    ['localnet', 'https://api.devnet.solana.com', wsUrl],
    ['localnet', rpcUrl, 'wss://api.mainnet-beta.solana.com'],
    ['localnet', 'http://localhost:18899', wsUrl],
    ['localnet', 'http://127.0.0.1:18899?token=private', wsUrl],
    ['localnet', 'http://user:private@127.0.0.1:18899', wsUrl],
    ['localnet', 'http://127.0.0.1:18899/proxy', wsUrl],
    ['localnet', 'http://2130706433:18899', wsUrl],
  ])('rejects unsafe scope without exposing input', (cluster, rpc, ws) => {
    expect(() => validateLocalEndpoints(cluster, rpc, ws)).toThrow(new RecoveryCheckError().message)
  })

  it('requires external temporary fixture files and rejects symlinks or repo artifacts', () => {
    const temp = mkdtempSync(path.join(tmpdir(), 'aveo-recovery-unit-'))
    const repo = path.join(temp, 'repository')
    const artifacts = path.join(temp, 'artifacts')
    mkdirSync(repo); mkdirSync(artifacts)
    for (const name of ['deployment.json', 'wallets.json']) writeFileSync(path.join(artifacts, name), '{}')
    try {
      expect(validateFixtureDirectory(artifacts, repo)).toBe(artifacts)
      expect(() => validateFixtureDirectory(undefined, repo)).toThrow(RecoveryCheckError)
      expect(() => validateFixtureDirectory('app/.dev', repo)).toThrow(RecoveryCheckError)
      expect(() => validateFixtureDirectory(artifacts, temp)).toThrow(RecoveryCheckError)
      const linked = path.join(temp, 'linked')
      symlinkSync(artifacts, linked)
      expect(() => validateFixtureDirectory(linked, repo)).toThrow(RecoveryCheckError)
      rmSync(path.join(artifacts, 'wallets.json'))
      symlinkSync(path.join(artifacts, 'deployment.json'), path.join(artifacts, 'wallets.json'))
      expect(() => validateFixtureDirectory(artifacts, repo)).toThrow(RecoveryCheckError)
    } finally { rmSync(temp, { recursive: true }) }
  })
})
