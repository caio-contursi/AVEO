import { isSignature } from '@solana/kit'
import type { DeskEvidence } from '../../api/backend'
import type { DeskIncident } from './model'

function validSignature(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]+$/.test(value) && isSignature(value)
}

/** Ambiguous signatures cannot identify a single evidence entry. */
export function unknownIncidentSignatures(incident: DeskIncident): string[] {
  if (incident.state === 'resolved') return []
  const counts = new Map<string, number>()
  for (const entry of incident.evidence) {
    if (entry.signature !== undefined) {
      counts.set(entry.signature, (counts.get(entry.signature) ?? 0) + 1)
    }
  }
  return incident.evidence.flatMap((entry) =>
    entry.status === 'unknown' && validSignature(entry.signature) &&
    counts.get(entry.signature) === 1 ? [entry.signature] : [])
}

/** Confirmation metadata never substitutes for fresh eligibility verification. */
export function applySignatureRecheck(
  current: DeskIncident, expected: DeskIncident, evidence: DeskEvidence, now: string,
): DeskIncident {
  if (current.state === 'resolved' || expected.state === 'resolved' ||
    current.id !== expected.id || current.key !== expected.key || current.type !== expected.type ||
    current.wallet !== expected.wallet || current.proof !== expected.proof ||
    current.affectedMints.length !== expected.affectedMints.length ||
    !current.affectedMints.every((mint, index) => mint === expected.affectedMints[index])) return current

  const { signature, status, slot } = evidence
  if (!validSignature(signature) ||
    (status !== 'confirmed' && status !== 'failed' && status !== 'unknown')) return current
  const currentEntries = current.evidence.filter((entry) => entry.signature === signature)
  const expectedEntries = expected.evidence.filter((entry) => entry.signature === signature)
  if (currentEntries.length !== 1 || expectedEntries.length !== 1 ||
    currentEntries[0]!.status !== 'unknown' || expectedEntries[0]!.status !== 'unknown') return current

  const floors = [current.detectedSlot, expected.detectedSlot,
    currentEntries[0]!.slot ?? 0, expectedEntries[0]!.slot ?? 0]
  if (!floors.every((value) => Number.isSafeInteger(value) && value >= 0)) return current
  if (slot !== undefined && (!Number.isSafeInteger(slot) || slot <= 0 || slot < Math.max(...floors))) return current
  if (status !== 'unknown' && slot === undefined) return current

  // Reconstruct from public metadata instead of retaining provider payloads.
  const replacement: DeskEvidence = { signature, status, ...(slot === undefined ? {} : { slot }), logs: [] }
  const nextEvidence = current.evidence.map((entry) => entry === currentEntries[0] ? replacement : entry)
  const awaiting = status === 'confirmed' || nextEvidence.some((entry) => entry.status === 'unknown' ||
    (entry.status === 'confirmed' && validSignature(entry.signature)))
  return {
    ...current,
    state: awaiting ? 'awaiting-confirmation' : 'open',
    evidence: nextEvidence,
    events: [...current.events, {
      at: now, kind: 'rechecked',
      params: { signature, status, ...(slot === undefined ? {} : { slot: String(slot) }) },
    }],
  }
}
