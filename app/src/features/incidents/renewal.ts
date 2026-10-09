import type { ProofRow } from '../../api/inventory'
import type { DeskIncident } from './model'

export interface RenewalCandidate {
  mint: string
  proof: ProofRow
}

export interface RenewalGroup {
  key: string
  mints: string[]
  attestation: string
}

export function groupRenewalCandidates(candidates: readonly RenewalCandidate[]): RenewalGroup[] {
  const groups = new Map<string, RenewalGroup>()
  const proofsByMint = new Map<string, string>()
  for (const { mint, proof } of candidates) {
    const attestation = proof.address
    const previous = proofsByMint.get(mint)
    if (previous !== undefined) {
      if (previous !== attestation) throw new Error('Conflicting renewal proofs for the same mint')
      continue
    }
    proofsByMint.set(mint, attestation)
    const group = groups.get(attestation)
    if (group) group.mints.push(mint)
    else groups.set(attestation, { key: attestation, mints: [mint], attestation })
  }
  return [...groups.values()]
}

export function hasPendingRenewal(incident: DeskIncident): boolean {
  if (incident.state === 'resolved') return false
  return incident.state === 'awaiting-confirmation' || incident.evidence.some((evidence) => evidence.status === 'unknown')
}

export function canPrepareRenewal(incident: DeskIncident): boolean {
  return (incident.state === 'open' || incident.state === 'action-prepared') &&
    incident.type !== 'READ_UNVERIFIABLE' && !hasPendingRenewal(incident)
}

export function sameRenewalIntent(current: DeskIncident, expected: DeskIncident): boolean {
  return canPrepareRenewal(current) && canPrepareRenewal(expected) &&
    current.id === expected.id && current.key === expected.key && current.type === expected.type &&
    current.wallet === expected.wallet && current.proof === expected.proof && current.observed === expected.observed &&
    current.affectedMints.length === expected.affectedMints.length &&
    current.affectedMints.every((mint, index) => mint === expected.affectedMints[index])
}
