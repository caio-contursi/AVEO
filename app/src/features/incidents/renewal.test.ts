import { describe, expect, it } from 'vitest'
import type { ProofRow } from '../../api/inventory'
import type { DeskIncident } from './model'
import { canPrepareRenewal, groupRenewalCandidates, hasPendingRenewal, sameRenewalIntent } from './renewal'

function proof(address: string): ProofRow {
  const value = address as ProofRow['address']
  return {
    address: value,
    wallet: value,
    boundTo: [],
    attestation: {
      nonce: value, credential: value, schema: value, signer: value, tokenAccount: value,
      data: new Uint8Array(), expiry: 0n,
    },
  }
}

function incident(overrides: Partial<DeskIncident> = {}): DeskIncident {
  return {
    id: 'incident-1', key: 'PROOF_EXPIRED|wallet|proof', type: 'PROOF_EXPIRED', state: 'open',
    wallet: 'wallet', proof: 'proof', observed: true, affectedMints: ['mint-a', 'mint-b'],
    detectedAt: '2026-10-09T00:00:00.000Z', detectedSlot: 100,
    cause: { code: 'AttestationExpired', message: 'Expired proof' }, events: [], evidence: [],
    ...overrides,
  }
}

describe('groupRenewalCandidates', () => {
  it('returns no groups for an empty input', () => {
    expect(groupRenewalCandidates(Object.freeze([]))).toEqual([])
  })

  it('preserves first proof and mint order and deduplicates by address', () => {
    const first = proof('proof-b')
    const second = proof('proof-a')
    const candidates = [
      { mint: 'mint-b', proof: first }, { mint: 'mint-c', proof: second },
      { mint: 'mint-a', proof: first }, { mint: 'mint-b', proof: proof('proof-b') },
      { mint: 'mint-d', proof: second },
    ]
    for (const candidate of candidates) {
      Object.freeze(candidate.proof.boundTo)
      Object.freeze(candidate.proof.attestation)
      Object.freeze(candidate.proof)
      Object.freeze(candidate)
    }
    Object.freeze(candidates)
    const before = structuredClone(candidates)
    const groups = groupRenewalCandidates(candidates)
    expect(groups).toEqual([
      { key: 'proof-b', attestation: 'proof-b', mints: ['mint-b', 'mint-a'] },
      { key: 'proof-a', attestation: 'proof-a', mints: ['mint-c', 'mint-d'] },
    ])
    groups[0]!.mints.push('output-only')
    expect(candidates).toEqual(before)
    expect(groupRenewalCandidates(candidates)[0]!.mints).toEqual(['mint-b', 'mint-a'])
  })

  it('rejects conflicting proofs for one mint with a static error', () => {
    for (const addresses of [['proof-a', 'proof-b'], ['private-a', 'private-b']]) {
      const candidates = Object.freeze(addresses.map((address) => Object.freeze({ mint: 'same-mint', proof: proof(address) })))
      const before = structuredClone(candidates)
      expect(() => groupRenewalCandidates(candidates)).toThrowError(new Error('Conflicting renewal proofs for the same mint'))
      expect(candidates).toEqual(before)
    }
  })
})

describe('renewal guards', () => {
  it.each(['open', 'action-prepared'] as const)('allows preparation in %s', (state) => {
    expect(canPrepareRenewal(incident({ state }))).toBe(true)
    expect(hasPendingRenewal(incident({ state }))).toBe(false)
  })

  it('blocks awaiting confirmation even without unknown evidence', () => {
    const current = incident({ state: 'awaiting-confirmation', evidence: [{ status: 'confirmed', logs: [] }] })
    expect(hasPendingRenewal(current)).toBe(true)
    expect(canPrepareRenewal(current)).toBe(false)
  })

  it.each(['open', 'action-prepared'] as const)('blocks unknown evidence in %s', (state) => {
    const current = incident({ state, evidence: [{ status: 'confirmed', logs: [] }, { status: 'unknown', logs: [] }] })
    expect(hasPendingRenewal(current)).toBe(true)
    expect(canPrepareRenewal(current)).toBe(false)
  })

  it.each(['confirmed', 'failed'] as const)('allows known %s evidence', (status) => {
    const current = incident({ evidence: [{ status, logs: [] }], events: [{ at: 'now', kind: 'unknown' }] })
    expect(hasPendingRenewal(current)).toBe(false)
    expect(canPrepareRenewal(current)).toBe(true)
  })

  it('blocks resolved incidents even with historical unknown evidence', () => {
    const current = incident({ state: 'resolved', evidence: [{ status: 'unknown', logs: [] }] })
    expect(hasPendingRenewal(current)).toBe(false)
    expect(canPrepareRenewal(current)).toBe(false)
  })

  it('blocks unverifiable reads', () => {
    expect(canPrepareRenewal(incident({ type: 'READ_UNVERIFIABLE' }))).toBe(false)
  })
})

describe('sameRenewalIntent', () => {
  it('stays valid across preparation and mutable history updates on frozen inputs', () => {
    const expected = incident()
    const current = incident({
      state: 'action-prepared', events: [{ at: 'now', kind: 'prepared' }],
      evidence: [{ status: 'failed', logs: ['failure'] }, { status: 'confirmed', logs: [] }],
      cause: { code: 'AttestationExpired', message: 'Updated diagnosis' }, detectedSlot: 200,
    })
    for (const value of [current, expected]) {
      Object.freeze(value.affectedMints)
      Object.freeze(value.events)
      Object.freeze(value.evidence)
      Object.freeze(value)
    }
    expect(sameRenewalIntent(current, expected)).toBe(true)
    expect(sameRenewalIntent(expected, current)).toBe(true)
  })

  it.each([
    { id: 'incident-2' }, { key: 'other-key' }, { type: 'PROOF_CLOSED' as const },
    { wallet: 'other-wallet' }, { proof: 'other-proof' }, { observed: false },
    { affectedMints: ['mint-a'] }, { affectedMints: ['mint-a', 'mint-b', 'mint-c'] },
    { affectedMints: ['mint-b', 'mint-a'] }, { affectedMints: ['mint-a', 'mint-c'] },
  ])('rejects stale intent after a change: %j', (change) => {
    const expected = incident()
    const current = incident(change)
    expect(sameRenewalIntent(current, expected)).toBe(false)
    expect(sameRenewalIntent(expected, current)).toBe(false)
  })

  it.each([
    { state: 'resolved' as const }, { state: 'awaiting-confirmation' as const },
    { type: 'READ_UNVERIFIABLE' as const }, { evidence: [{ status: 'unknown' as const, logs: [] }] },
  ])('requires both incidents to allow preparation: %j', (change) => {
    const blocked = incident(change)
    expect(sameRenewalIntent(blocked, incident())).toBe(false)
    expect(sameRenewalIntent(incident(), blocked)).toBe(false)
    expect(sameRenewalIntent(blocked, blocked)).toBe(false)
  })

  it('allows an unchanged incident no longer observed by the last scan', () => {
    expect(sameRenewalIntent(incident({ observed: false }), incident({ observed: false, state: 'action-prepared' }))).toBe(true)
  })
})
