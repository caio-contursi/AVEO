import { getAddressDecoder, getBase58Decoder, isSignature } from '@solana/kit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeskEvidence } from '../../api/backend'
import type { ApiContext } from '../../api/context'
import { confirmSignature, type Confirmation } from '../../api/transactions'
import type { SubmissionJournal, SubmissionReceipt } from '../operations/submission-journal'
import { recheckIncidentSignature } from './confirmation-recovery'
import type { DeskIncident } from './model'

// Any attempt to call a transaction-building or sending export fails this mock.
vi.mock('../../api/transactions', () => ({ confirmSignature: vi.fn() }))

const publicSignature = getBase58Decoder().decode(new Uint8Array(64).fill(1))
const otherSignature = getBase58Decoder().decode(new Uint8Array(64).fill(2))
const privateDetail = 'https://user:password@rpc.invalid/?apiKey=private-token'
const confirm = vi.mocked(confirmSignature)
const unknown: DeskEvidence = { status: 'unknown', signature: publicSignature, logs: [] }

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

const ctx = freeze({
  cluster: 'localnet', commitment: 'confirmed',
  programId: getAddressDecoder().decode(new Uint8Array(32).fill(7)),
  rpcUrl: privateDetail, rpc: {},
  deployment: { generatedAt: '2026-10-09T12:00:00.000Z' },
} as ApiContext)

function incident(overrides: Partial<DeskIncident> = {}): DeskIncident {
  return freeze({
    id: 'incident-1', key: 'PROOF_EXPIRED|wallet|proof', type: 'PROOF_EXPIRED',
    state: 'awaiting-confirmation', wallet: 'wallet', proof: 'proof', observed: true,
    affectedMints: ['mint'], detectedAt: '2026-10-09T12:00:00.000Z', detectedSlot: 100,
    cause: { code: 'AttestationExpired', message: 'Expired proof' },
    events: [], evidence: [{ ...unknown, slot: 120 }], ...overrides,
  })
}

function receipt(signature = publicSignature): SubmissionReceipt {
  return freeze({
    version: 1, signature, submittedAt: '2026-10-09T12:01:00.000Z',
    cluster: ctx.cluster, commitment: ctx.commitment, programId: ctx.programId,
    deploymentGeneratedAt: ctx.deployment.generatedAt, rpcFingerprint: 'a'.repeat(64),
  })
}

function journalStub(initial: readonly SubmissionReceipt[] = [receipt()]) {
  let snapshot = Object.freeze([...initial])
  const journal = Object.freeze({
    getSnapshot: vi.fn<SubmissionJournal['getSnapshot']>(() => snapshot),
    matches: vi.fn<SubmissionJournal['matches']>(async () => true),
  }) satisfies Pick<SubmissionJournal, 'getSnapshot' | 'matches'>
  return {
    journal,
    replace: (next: readonly SubmissionReceipt[]) => { snapshot = Object.freeze([...next]) },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}

function observation(status: Confirmation['status'], slot?: number) {
  return freeze({
    status, slot, signature: otherSignature,
    logs: [privateDetail], error: { code: 'ReadUnverifiable', message: privateDetail },
    readback: [{ privateDetail }], balances: [{ privateDetail }], rawError: privateDetail,
  } as Confirmation & { signature: string })
}

beforeEach(() => {
  confirm.mockReset().mockResolvedValue(observation('confirmed', 130))
})

afterEach(() => { vi.unstubAllGlobals() })

describe('recheckIncidentSignature', () => {
  it('rejects an invalid base58 alphabet even when incident and receipt signatures match', async () => {
    const invalid = '0'.repeat(88)
    const current = incident({ evidence: [{ ...unknown, signature: invalid }] })
    const { journal } = journalStub([receipt(invalid)])
    expect(await recheckIncidentSignature(ctx, current, invalid, journal)).toBeUndefined()
    expect(confirm).not.toHaveBeenCalled()
    expect(journal.matches).not.toHaveBeenCalled()
  })

  it('discards a terminal reply when the original receipt becomes duplicated during the RPC request', async () => {
    const read = deferred<Confirmation>(), entered = deferred<void>()
    confirm.mockImplementationOnce(() => { entered.resolve(); return read.promise })
    const { journal, replace } = journalStub()
    const original = journal.getSnapshot()[0]!
    const pending = recheckIncidentSignature(ctx, incident(), publicSignature, journal)
    await entered.promise
    replace([original, original])
    read.resolve(observation('confirmed', 130))
    expect(await pending).toBeUndefined()
    expect(confirm).toHaveBeenCalledOnce()
  })

  it('does nothing until explicitly requested and only queries public confirmation on frozen inputs', async () => {
    const current = incident()
    const { journal } = journalStub()
    const before = structuredClone(current)
    const forbidden = vi.fn(() => { throw new Error(privateDetail) })
    vi.stubGlobal('fetch', forbidden)
    vi.stubGlobal('localStorage', Object.freeze({ getItem: forbidden, setItem: forbidden }))
    expect(isSignature(publicSignature)).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    expect(journal.matches).not.toHaveBeenCalled()

    const result = await recheckIncidentSignature(ctx, current, publicSignature, journal)

    expect(result).toEqual({ status: 'confirmed', signature: publicSignature, slot: 130, logs: [] })
    expect(confirm).toHaveBeenCalledExactlyOnceWith(ctx, publicSignature, 15_000)
    expect(journal.matches).toHaveBeenCalledExactlyOnceWith(ctx, journal.getSnapshot()[0])
    expect(forbidden).not.toHaveBeenCalled()
    expect(current).toEqual(before)
    expect(Object.isFrozen(current.evidence[0])).toBe(true)
    expect(Object.isFrozen(journal)).toBe(true)
    expect(Object.isFrozen(journal.getSnapshot())).toBe(true)
    expect(Object.isFrozen(journal.getSnapshot()[0])).toBe(true)
  })

  it.each(['confirmed', 'finalized'] as const)('supports %s context commitment', async (commitment) => {
    const context = freeze({ ...ctx, commitment })
    const { journal } = journalStub()
    expect(await recheckIncidentSignature(context, incident(), publicSignature, journal)).toEqual({
      status: 'confirmed', signature: publicSignature, slot: 130, logs: [],
    })
    expect(journal.matches).toHaveBeenCalledExactlyOnceWith(context, journal.getSnapshot()[0])
    expect(confirm).toHaveBeenCalledExactlyOnceWith(context, publicSignature, 15_000)
  })

  it.each(['', 'invalid', '0'.repeat(88), getBase58Decoder().decode(new Uint8Array(32).fill(1))])(
    'rejects invalid signature %j before journal checks or RPC', async (signature) => {
      const { journal } = journalStub()
      expect(await recheckIncidentSignature(ctx, incident(), signature, journal)).toBeUndefined()
      expect(journal.getSnapshot).not.toHaveBeenCalled()
      expect(journal.matches).not.toHaveBeenCalled()
      expect(confirm).not.toHaveBeenCalled()
    },
  )

  it.each([
    { state: 'resolved' as const },
    { evidence: [] },
    { evidence: [{ ...unknown, signature: otherSignature }] },
    { evidence: [{ ...unknown, status: 'confirmed' as const }] },
    { evidence: [{ ...unknown, status: 'failed' as const }] },
    { evidence: [{ ...unknown }, { ...unknown }] },
    { evidence: [{ ...unknown }, { ...unknown, status: 'confirmed' as const }] },
  ])('rejects resolved, absent, terminal or ambiguous incident evidence: %j', async (overrides) => {
    const { journal } = journalStub()
    expect(await recheckIncidentSignature(ctx, incident(overrides), publicSignature, journal)).toBeUndefined()
    expect(journal.matches).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
  })

  it.each(['open', 'action-prepared', 'awaiting-confirmation'] as const)(
    'accepts one unknown signature in an unresolved %s incident with unrelated evidence', async (state) => {
      const current = incident({ state, evidence: [unknown, { ...unknown, signature: otherSignature, slot: 999 }] })
      const { journal } = journalStub([receipt(otherSignature), receipt()])
      expect(await recheckIncidentSignature(ctx, current, publicSignature, journal)).toEqual({
        status: 'confirmed', signature: publicSignature, slot: 130, logs: [],
      })
      expect(journal.matches).toHaveBeenCalledExactlyOnceWith(ctx, journal.getSnapshot()[1])
      expect(confirm).toHaveBeenCalledTimes(1)
    },
  )

  it.each(['missing', 'different signature', 'duplicate', 'same object twice'])(
    'rejects %s receipts before scope validation or RPC', async (kind) => {
      const original = receipt()
      const entries = kind === 'missing' ? [] : kind === 'different signature' ? [receipt(otherSignature)]
        : kind === 'duplicate' ? [original, receipt()] : [original, original]
      const { journal } = journalStub(entries)
      expect(await recheckIncidentSignature(ctx, incident(), publicSignature, journal)).toBeUndefined()
      expect(journal.matches).not.toHaveBeenCalled()
      expect(confirm).not.toHaveBeenCalled()
    },
  )

  it('rejects processed commitment without RPC or receipt validation', async () => {
    const { journal } = journalStub()
    expect(await recheckIncidentSignature(freeze({ ...ctx, commitment: 'processed' }), incident(), publicSignature, journal)).toBeUndefined()
    expect(journal.matches).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
  })

  it('defers to journal.matches for a wrong context instead of trusting matching signature metadata', async () => {
    const context = freeze({ ...ctx, rpcUrl: 'https://different.invalid' })
    const { journal } = journalStub()
    journal.matches.mockResolvedValue(false)
    expect(await recheckIncidentSignature(context, incident(), publicSignature, journal)).toBeUndefined()
    expect(journal.matches).toHaveBeenCalledExactlyOnceWith(context, journal.getSnapshot()[0])
    expect(confirm).not.toHaveBeenCalled()
  })

  it('checks isCurrent before consulting the journal', async () => {
    const { journal } = journalStub()
    const isCurrent = vi.fn(() => false)
    expect(await recheckIncidentSignature(ctx, incident(), publicSignature, journal, isCurrent)).toBeUndefined()
    expect(isCurrent).toHaveBeenCalledTimes(1)
    expect(journal.getSnapshot).not.toHaveBeenCalled()
    expect(journal.matches).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
  })

  it.each(['callback invalidated', 'removed', 'replaced', 'scope rejected'])(
    'waits for matches and discards %s before RPC', async (change) => {
      const match = deferred<boolean>()
      const { journal, replace } = journalStub()
      const original = journal.getSnapshot()[0]!
      journal.matches.mockReturnValue(match.promise)
      let current = true
      const pending = recheckIncidentSignature(ctx, incident(), publicSignature, journal, () => current)
      expect(journal.matches).toHaveBeenCalledExactlyOnceWith(ctx, original)
      expect(confirm).not.toHaveBeenCalled()
      if (change === 'callback invalidated') current = false
      if (change === 'removed') replace([])
      if (change === 'replaced') replace([freeze({ ...original })])
      match.resolve(change !== 'scope rejected')
      expect(await pending).toBeUndefined()
      expect(confirm).not.toHaveBeenCalled()
    },
  )

  it('queries only after asynchronous scope validation succeeds', async () => {
    const match = deferred<boolean>()
    const { journal } = journalStub()
    journal.matches.mockReturnValue(match.promise)
    const pending = recheckIncidentSignature(ctx, incident(), publicSignature, journal)
    expect(confirm).not.toHaveBeenCalled()
    match.resolve(true)
    expect(await pending).toEqual({ status: 'confirmed', signature: publicSignature, slot: 130, logs: [] })
    expect(confirm).toHaveBeenCalledExactlyOnceWith(ctx, publicSignature, 15_000)
  })

  it.each(['confirmed', 'failed', 'unknown', 'rejected'] as const)(
    'discards a %s RPC reply after callback invalidation, removal or replacement', async (reply) => {
      for (const change of ['callback invalidated', 'removed', 'replaced']) {
        confirm.mockClear()
        const read = deferred<Confirmation>()
        const entered = deferred<void>()
        confirm.mockImplementationOnce(() => { entered.resolve(); return read.promise })
        const { journal, replace } = journalStub()
        const original = journal.getSnapshot()[0]!
        let current = true
        const pending = recheckIncidentSignature(ctx, incident(), publicSignature, journal, () => current)
        await entered.promise
        if (change === 'callback invalidated') current = false
        if (change === 'removed') replace([])
        if (change === 'replaced') replace([freeze({ ...original })])
        if (reply === 'rejected') read.reject(new Error(privateDetail))
        else read.resolve(observation(reply, 130))
        expect(await pending).toBeUndefined()
        expect(confirm).toHaveBeenCalledExactlyOnceWith(ctx, publicSignature, 15_000)
      }
    },
  )

  it('accepts a refreshed snapshot array only when it retains the identical receipt object', async () => {
    const read = deferred<Confirmation>()
    const entered = deferred<void>()
    confirm.mockImplementationOnce(() => { entered.resolve(); return read.promise })
    const { journal, replace } = journalStub()
    const original = journal.getSnapshot()[0]!
    const pending = recheckIncidentSignature(ctx, incident(), publicSignature, journal)
    await entered.promise
    replace([receipt(otherSignature), original])
    read.resolve(observation('confirmed', 130))
    expect(await pending).toEqual({ status: 'confirmed', signature: publicSignature, slot: 130, logs: [] })
  })

  it.each(['confirmed', 'failed'] as const)('keeps %s only at safe slots above both floors and strips private fields', async (status) => {
    for (const slot of [120, 130, Number.MAX_SAFE_INTEGER]) {
      const reply = observation(status, slot)
      confirm.mockResolvedValueOnce(reply)
      const { journal } = journalStub()
      const result = await recheckIncidentSignature(ctx, incident(), publicSignature, journal)
      expect(result).toEqual({ status, signature: publicSignature, slot, logs: [] })
      expect(result).not.toBe(reply)
      expect(JSON.stringify(result)).not.toContain(privateDetail)
      expect(reply.logs).toEqual([privateDetail])
    }
  })

  it.each(['confirmed', 'failed'] as const)('downgrades %s with missing, stale or unsafe slots to sanitized unknown', async (status) => {
    for (const slot of [undefined, 0, -1, 99, 100, 119, 120.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      confirm.mockResolvedValueOnce(observation(status, slot))
      const { journal } = journalStub()
      expect(await recheckIncidentSignature(ctx, incident(), publicSignature, journal)).toEqual(unknown)
    }
  })

  it.each(['confirmed', 'failed'] as const)('enforces detectedSlot even when previous evidence has a lower or absent slot: %s', async (status) => {
    for (const previousSlot of [undefined, 50]) {
      const current = incident({ evidence: [{ ...unknown, slot: previousSlot }] })
      const { journal } = journalStub()
      confirm.mockResolvedValueOnce(observation(status, 99))
      expect(await recheckIncidentSignature(ctx, current, publicSignature, journal)).toEqual(unknown)
      confirm.mockResolvedValueOnce(observation(status, 100))
      expect(await recheckIncidentSignature(ctx, current, publicSignature, journal)).toEqual({
        status, signature: publicSignature, slot: 100, logs: [],
      })
    }
  })

  it.each(['confirmed', 'failed'] as const)('requires a positive slot even when both floors are zero: %s', async (status) => {
    const current = incident({ detectedSlot: 0, evidence: [unknown] })
    const { journal } = journalStub()
    confirm.mockResolvedValueOnce(observation(status, 0))
    expect(await recheckIncidentSignature(ctx, current, publicSignature, journal)).toEqual(unknown)
    confirm.mockResolvedValueOnce(observation(status, 1))
    expect(await recheckIncidentSignature(ctx, current, publicSignature, journal)).toEqual({
      status, signature: publicSignature, slot: 1, logs: [],
    })
  })

  it('never promotes unknown even when the provider returns a safe slot and private details', async () => {
    confirm.mockResolvedValueOnce(observation('unknown', 130))
    const { journal } = journalStub()
    expect(await recheckIncidentSignature(ctx, incident(), publicSignature, journal)).toEqual(unknown)
  })

  it.each([new Error(privateDetail), { logs: [privateDetail], rawError: privateDetail }, privateDetail])(
    'sanitizes rejected confirmation while the original receipt remains current: %#', async (error) => {
      confirm.mockRejectedValueOnce(error)
      const { journal } = journalStub()
      expect(await recheckIncidentSignature(ctx, incident(), publicSignature, journal)).toEqual(unknown)
      expect(confirm).toHaveBeenCalledExactlyOnceWith(ctx, publicSignature, 15_000)
    },
  )

  it.each([1, 2, 3])('fails closed if isCurrent throws on check %i', async (check) => {
    const { journal } = journalStub()
    let calls = 0
    const isCurrent = vi.fn(() => { if (++calls === check) throw new Error(privateDetail); return true })
    expect(await recheckIncidentSignature(ctx, incident(), publicSignature, journal, isCurrent)).toBeUndefined()
    expect(confirm).toHaveBeenCalledTimes(check === 3 ? 1 : 0)
  })

  it.each([1, 2, 3])('fails closed if getSnapshot throws on read %i', async (read) => {
    const { journal } = journalStub()
    const snapshot = journal.getSnapshot()
    let reads = 0
    journal.getSnapshot.mockImplementation(() => { if (++reads === read) throw new Error(privateDetail); return snapshot })
    expect(await recheckIncidentSignature(ctx, incident(), publicSignature, journal)).toBeUndefined()
    expect(confirm).toHaveBeenCalledTimes(read === 3 ? 1 : 0)
  })

  it.each(['synchronous', 'asynchronous'])('fails closed on %s matches exceptions', async (failure) => {
    const { journal } = journalStub()
    if (failure === 'synchronous') journal.matches.mockImplementation(() => { throw new Error(privateDetail) })
    else journal.matches.mockRejectedValue(new Error(privateDetail))
    expect(await recheckIncidentSignature(ctx, incident(), publicSignature, journal)).toBeUndefined()
    expect(confirm).not.toHaveBeenCalled()
  })

  it.each(['callback', 'snapshot'])('fails closed if the %s guard throws while handling a rejected RPC', async (guard) => {
    const { journal } = journalStub()
    const snapshot = journal.getSnapshot()
    const isCurrent = vi.fn(() => true)
    confirm.mockImplementationOnce(async () => {
      if (guard === 'callback') isCurrent.mockImplementation(() => { throw new Error(privateDetail) })
      else journal.getSnapshot.mockImplementation(() => { throw new Error(privateDetail) })
      throw new Error(privateDetail)
    })
    expect(await recheckIncidentSignature(ctx, incident(), publicSignature, journal, isCurrent)).toBeUndefined()
    expect(snapshot).toHaveLength(1)
  })
})
