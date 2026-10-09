import { isSignature } from '@solana/kit'
import { describe, expect, it } from 'vitest'
import type { DeskEvidence } from '../../api/backend'
import type { DeskIncident } from './model'
import { applySignatureRecheck, unknownIncidentSignatures } from './confirmation-model'

const signature = '1'.repeat(64)
const otherSignature = `${'1'.repeat(63)}2`
const now = '2026-10-09T12:00:00Z'

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

function incident(overrides: Partial<DeskIncident> = {}): DeskIncident {
  return freeze({
    id: 'incident-1', key: 'PROOF_EXPIRED|wallet|proof', type: 'PROOF_EXPIRED',
    state: 'awaiting-confirmation', wallet: 'wallet', proof: 'proof',
    affectedMints: ['mint-a', 'mint-b'], detectedAt: now, detectedSlot: 100,
    cause: { code: 'AttestationExpired', message: 'Expired' }, observed: true,
    events: [{ at: now, kind: 'signed', params: { signature } }],
    evidence: [{ signature, status: 'unknown', slot: 110, logs: [] }],
    ...overrides,
  })
}

function observation(overrides: Partial<DeskEvidence> = {}): DeskEvidence {
  return freeze({ signature, status: 'confirmed', slot: 120, logs: [], ...overrides })
}

describe('unknownIncidentSignatures', () => {
  it('returns unique valid unknown signatures in evidence order on frozen inputs', () => {
    expect(isSignature(signature)).toBe(true)
    expect(isSignature(otherSignature)).toBe(true)
    const current = incident({ evidence: [
      { signature: otherSignature, status: 'unknown', logs: [] },
      { status: 'unknown', logs: [] }, { signature: '0'.repeat(88), status: 'unknown', logs: [] },
      { signature, status: 'unknown', logs: [] },
    ] })
    const result = unknownIncidentSignatures(current)
    expect(result).toEqual([otherSignature, signature])
    result.pop()
    expect(unknownIncidentSignatures(current)).toEqual([otherSignature, signature])
  })

  it.each(['unknown', 'confirmed', 'failed'] as const)('excludes every duplicate including a %s sibling', (status) => {
    expect(unknownIncidentSignatures(incident({ evidence: [
      observation({ status: 'unknown' }), observation({ status }),
      observation({ signature: otherSignature, status: 'unknown' }),
    ] }))).toEqual([otherSignature])
  })

  it('excludes terminal evidence and resolved incidents', () => {
    expect(unknownIncidentSignatures(incident({ state: 'resolved' }))).toEqual([])
    expect(unknownIncidentSignatures(incident({ evidence: [observation(), observation({ status: 'failed' })] }))).toEqual([])
  })
})

describe('applySignatureRecheck', () => {
  it.each(['confirmed', 'failed', 'unknown'] as const)('replaces only its unknown with minimal %s metadata', (status) => {
    const unrelated = observation({ signature: otherSignature, status: 'failed', logs: ['historic log'] })
    const current = incident({ evidence: [unrelated, observation({ status: 'unknown' })] })
    const before = structuredClone(current)
    const raw = freeze({ ...observation({ status }), logs: ['https://private-rpc/?token=secret'],
      error: { code: 'ReadUnverifiable', message: 'provider secret' }, readback: [], balances: [],
      endpoint: 'private endpoint', rawProviderError: 'secret',
    }) as DeskEvidence
    const next = applySignatureRecheck(current, incident(), raw, now)
    expect(next.evidence).toEqual([unrelated, { signature, status, slot: 120, logs: [] }])
    expect(next.evidence[0]).toBe(unrelated)
    expect(next.evidence[1]).not.toBe(raw)
    expect(next.state).toBe(status === 'failed' ? 'open' : 'awaiting-confirmation')
    expect(next.events).toEqual([...current.events, { at: now, kind: 'rechecked', params: { signature, status, slot: '120' } }])
    expect(next.events[0]).toBe(current.events[0])
    expect(next.events.filter((event) => event.kind === 'signed')).toHaveLength(1)
    expect(next.events.some((event) => event.kind === 'resolved')).toBe(false)
    expect(next.resolvedSlot).toBeUndefined()
    expect(JSON.stringify(next)).not.toMatch(/private-rpc|provider secret|private endpoint|rawProviderError/)
    expect(current).toEqual(before)
  })

  it('allows repeated unknown retries and eventual confirmation without another signing event', () => {
    const start = incident()
    const retry = observation({ status: 'unknown', slot: undefined })
    const first = freeze(applySignatureRecheck(start, start, retry, now))
    expect(first.evidence).toEqual([{ signature, status: 'unknown', logs: [] }])
    expect(first.events.at(-1)!.params).toEqual({ signature, status: 'unknown' })
    const second = freeze(applySignatureRecheck(first, first, retry, now))
    const confirmed = applySignatureRecheck(second, second, observation(), now)
    expect(confirmed.state).toBe('awaiting-confirmation')
    expect(confirmed.events.filter((event) => event.kind === 'signed')).toHaveLength(1)
    expect(confirmed.events.filter((event) => event.kind === 'rechecked')).toHaveLength(3)
  })

  it.each([
    { id: 'other' }, { key: 'other' }, { type: 'PROOF_CLOSED' as const },
    { wallet: 'other' }, { proof: 'other' }, { affectedMints: ['mint-a'] },
    { affectedMints: ['mint-a', 'mint-b', 'mint-c'] }, { affectedMints: ['mint-b', 'mint-a'] },
    { affectedMints: ['mint-a', 'mint-c'] }, { state: 'resolved' as const, resolvedSlot: 130 },
  ])('preserves the exact current object for identity or asset mismatch %j', (change) => {
    const current = incident(change)
    expect(applySignatureRecheck(current, incident(), observation(), now)).toBe(current)
    const original = incident()
    expect(applySignatureRecheck(original, current, observation(), now)).toBe(original)
  })

  it.each(['', 'bad', '0'.repeat(88), 'O'.repeat(88), '1'.repeat(63), '1'.repeat(65)])('rejects invalid signature %s', (invalid) => {
    const current = incident({ evidence: [observation({ signature: invalid, status: 'unknown' })] })
    expect(unknownIncidentSignatures(current)).toEqual([])
    expect(applySignatureRecheck(current, current, observation({ signature: invalid }), now)).toBe(current)
  })

  it.each([undefined, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 109])('rejects invalid or stale terminal slot %s', (slot) => {
    const current = incident()
    for (const status of ['confirmed', 'failed'] as const) {
      expect(applySignatureRecheck(current, current, observation({ status, slot }), now)).toBe(current)
    }
  })

  it('uses both detected slots and both previous slots as the terminal floor', () => {
    for (const [current, expected] of [
      [incident({ detectedSlot: 150 }), incident()], [incident(), incident({ detectedSlot: 150 })],
      [incident({ evidence: [observation({ status: 'unknown', slot: 150 })] }), incident()],
      [incident(), incident({ evidence: [observation({ status: 'unknown', slot: 150 })] })],
    ]) {
      expect(applySignatureRecheck(current!, expected!, observation({ slot: 149 }), now)).toBe(current)
      expect(applySignatureRecheck(current!, expected!, observation({ slot: 150 }), now).state).toBe('awaiting-confirmation')
    }
  })

  it.each(['confirmed', 'failed'] as const)('rejects a %s source in either snapshot', (status) => {
    const terminal = incident({ evidence: [observation({ status })] })
    const pending = incident()
    expect(applySignatureRecheck(pending, terminal, observation(), now)).toBe(pending)
    expect(applySignatureRecheck(terminal, pending, observation(), now)).toBe(terminal)
  })

  it('rejects missing, mismatched and duplicate sources in either snapshot', () => {
    const pending = incident()
    for (const evidence of [[], [observation({ signature: otherSignature, status: 'unknown' })],
      [observation({ status: 'unknown' }), observation({ status: 'unknown' })],
      [observation({ status: 'unknown' }), observation()],
    ]) {
      const changed = incident({ evidence })
      expect(applySignatureRecheck(pending, changed, observation(), now)).toBe(pending)
      expect(applySignatureRecheck(changed, pending, observation(), now)).toBe(changed)
    }
    expect(applySignatureRecheck(pending, pending, observation({ signature: otherSignature }), now)).toBe(pending)
  })

  it('rejects unsupported status, invalid unknown slots and malformed source floors', () => {
    const current = incident()
    expect(applySignatureRecheck(current, current, observation({ status: 'resolved' as DeskEvidence['status'] }), now)).toBe(current)
    for (const slot of [0, -1, NaN, Infinity, 1.5, 109]) {
      expect(applySignatureRecheck(current, current, observation({ status: 'unknown', slot }), now)).toBe(current)
    }
    for (const slot of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      for (const invalid of [incident({ detectedSlot: slot }), incident({ evidence: [observation({ status: 'unknown', slot })] })]) {
        expect(applySignatureRecheck(current, invalid, observation(), now)).toBe(current)
        expect(applySignatureRecheck(invalid, current, observation(), now)).toBe(invalid)
      }
    }
  })

  it.each([
    { status: 'unknown' as const, signature: otherSignature, state: 'awaiting-confirmation' },
    { status: 'unknown' as const, signature: undefined, state: 'awaiting-confirmation' },
    { status: 'confirmed' as const, signature: otherSignature, state: 'awaiting-confirmation' },
    { status: 'confirmed' as const, signature: undefined, state: 'open' },
    { status: 'failed' as const, signature: otherSignature, state: 'open' },
  ])('keeps mixed groups safe after failure: %j', ({ status, signature: sibling, state }) => {
    const current = incident({ evidence: [observation({ status: 'unknown' }), observation({ status, signature: sibling })] })
    const next = applySignatureRecheck(current, current, observation({ status: 'failed' }), now)
    expect(next.state).toBe(state)
    expect(next.evidence[1]).toBe(current.evidence[1])
  })

  it('accepts history and observation changes without restoring stale snapshot fields', () => {
    const current = incident({ observed: false, state: 'action-prepared', events: [{ at: now, kind: 'prepared' }],
      cause: { code: 'ReadUnverifiable', message: 'Current diagnosis' } })
    const next = applySignatureRecheck(current, incident(), observation(), now)
    expect(next.observed).toBe(false)
    expect(next.cause).toBe(current.cause)
    expect(next.events[0]).toBe(current.events[0])
  })
})
