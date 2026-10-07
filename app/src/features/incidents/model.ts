// Regras do scan:once e do ciclo de incidentes (spec v3, seção 8). Funções puras; o armazenamento fica em store.ts.
import { isStandingPolicyRejection } from '@aveo/backend-aveo'
import type { Incident, IncidentType } from '@aveo/contracts'
import type { DeskEvidence } from '../../api/backend'
import type { DeskSnapshot, DiagnosticReason, ReasonCode } from '../../api/diagnostics'

export type EventKind = 'detected' | 'prepared' | 'signed' | 'sendFailed' | 'resolved' | 'stillBlocked' | 'unknown'

export interface IncidentEvent {
  at: string
  kind: EventKind
  params?: Record<string, string>
}

export interface DeskIncident extends Incident {
  /** tipo|carteira|prova: o mesmo problema visto de novo não abre outro incidente. */
  key: string
  cause: DiagnosticReason
  /** false quando o último scan não viu mais o problema. Isso não resolve o incidente. */
  observed: boolean
  events: IncidentEvent[]
  evidence: DeskEvidence[]
  resolvedSlot?: number
}

export interface IncidentStoreData {
  version: 1
  lastScan?: { slot: number; at: string }
  /** Última prova vinculada vista por mint:carteira. Reconhece leitura falha e política inativa. */
  watched: Record<string, string>
  incidents: DeskIncident[]
}

export const EMPTY_STORE: IncidentStoreData = { version: 1, watched: {}, incidents: [] }

const TYPE_BY_CODE: Partial<Record<ReasonCode, IncidentType>> = {
  AttestationExpired: 'PROOF_EXPIRED',
  AttestationMissingOrClosed: 'PROOF_CLOSED',
  InvalidSasOwnerOrData: 'PROOF_CLOSED',
  // set_binding já confere o titular; se divergir depois, a prova vinculada deixou de servir.
  SubjectMismatch: 'PROOF_CLOSED',
  BindingSubjectMismatch: 'PROOF_CLOSED',
  ProviderPairNotAllowed: 'PROVIDER_REMOVED',
  SchemaMismatchOrPaused: 'PROVIDER_REMOVED',
  UnauthorizedAttestationSigner: 'PROVIDER_REMOVED',
  PolicyMissingOrInactive: 'POLICY_CHANGED',
  RequiredFactMissing: 'POLICY_CHANGED',
  ProofDomainMismatch: 'POLICY_CHANGED',
  MintMismatch: 'POLICY_CHANGED',
  ReadUnverifiable: 'READ_UNVERIFIABLE',
}

export function incidentTypeFor(code: ReasonCode): IncidentType {
  return TYPE_BY_CODE[code] ?? 'POLICY_CHANGED'
}

interface Finding {
  type: IncidentType
  mint: string
  wallet: string
  proof: string
  cause: DiagnosticReason
}

const pairKey = (mint: string, wallet: string) => `${mint}:${wallet}`

/**
 * Só vira incidente quem tinha vínculo: carteira sem binding (BindingMissing) é onboarding, não incidente.
 * Leitura falha só abre READ_UNVERIFIABLE para um vínculo já visto num scan anterior.
 */
export function findIncidents(snapshots: DeskSnapshot[], watched: Record<string, string>) {
  const next = { ...watched }
  const findings: Finding[] = []
  for (const snapshot of snapshots) {
    const key = pairKey(snapshot.mint, snapshot.wallet)
    const bound = snapshot.sourceAccounts.attestation
    if (snapshot.verdict === 'eligible') {
      if (bound) next[key] = bound
      continue
    }
    const primary = snapshot.reasons.find((r) => !r.hint)
    if (!primary) continue
    if (snapshot.verdict === 'ineligible' && primary.code === 'BindingMissing') {
      delete next[key]
      continue
    }
    // Vínculo de uma prova que a política nunca aceitou (T02/T03) é diagnóstico.
    // Vira incidente só se a carteira já tinha sido elegível nesse ativo (T08).
    if (snapshot.verdict === 'ineligible' && isStandingPolicyRejection(primary.code, watched[key] !== undefined)) {
      continue
    }
    const proof = snapshot.verdict === 'unknown' ? watched[key] : (bound ?? watched[key])
    if (!proof) continue
    next[key] = proof
    const type = snapshot.verdict === 'unknown' ? 'READ_UNVERIFIABLE' : incidentTypeFor(primary.code)
    findings.push({ type, mint: snapshot.mint, wallet: snapshot.wallet, proof, cause: primary })
  }
  return { findings, watched: next }
}

/** Aplica um scan: uma prova afetada agrupa os ativos, e repetir o scan não duplica incidente. */
export function applyScan(data: IncidentStoreData, snapshots: DeskSnapshot[], slot: number, now: string): IncidentStoreData {
  const { findings, watched } = findIncidents(snapshots, data.watched)
  const groups = new Map<string, Finding & { mints: string[] }>()
  for (const finding of findings) {
    const key = `${finding.type}|${finding.wallet}|${finding.proof}`
    const group = groups.get(key)
    if (group) {
      if (!group.mints.includes(finding.mint)) group.mints.push(finding.mint)
    } else {
      groups.set(key, { ...finding, mints: [finding.mint] })
    }
  }

  const incidents = data.incidents.map((incident) => (incident.state === 'resolved' ? incident : { ...incident, observed: false }))
  for (const [key, group] of groups) {
    const index = incidents.findIndex((i) => i.key === key && i.state !== 'resolved')
    if (index >= 0) {
      const current = incidents[index]!
      incidents[index] = {
        ...current,
        observed: true,
        cause: group.cause,
        affectedMints: [...current.affectedMints, ...group.mints.filter((m) => !current.affectedMints.includes(m))],
      }
    } else {
      incidents.push({
        id: `${key}@${slot}`,
        key,
        type: group.type,
        state: 'open',
        wallet: group.wallet,
        proof: group.proof,
        affectedMints: group.mints,
        detectedAt: now,
        detectedSlot: slot,
        cause: group.cause,
        observed: true,
        events: [{ at: now, kind: 'detected' }],
        evidence: [],
      })
    }
  }
  return { ...data, lastScan: { slot, at: now }, watched, incidents }
}

export function markPrepared(incident: DeskIncident, plans: number, now: string): DeskIncident {
  if (incident.state === 'resolved') return incident
  return { ...incident, state: 'action-prepared', events: [...incident.events, { at: now, kind: 'prepared', params: { n: String(plans) } }] }
}

export type SendOutcome = { evidence: DeskEvidence } | { error: DiagnosticReason }

/**
 * Registra os envios do novo vínculo. Recusa ou erro devolve ao estado aberto.
 * Enviado (confirmado ou desconhecido) espera a verificação.
 */
export function applySends(incident: DeskIncident, outcomes: SendOutcome[], now: string): DeskIncident {
  const events: IncidentEvent[] = []
  const evidence: DeskEvidence[] = []
  let sent = false
  for (const outcome of outcomes) {
    if ('error' in outcome) {
      events.push({ at: now, kind: 'sendFailed', params: { code: outcome.error.code } })
      continue
    }
    evidence.push(outcome.evidence)
    const signature = outcome.evidence.signature ?? ''
    if (outcome.evidence.status === 'failed') {
      events.push({ at: now, kind: 'sendFailed', params: { code: outcome.evidence.error?.code ?? 'SimulationFailed' } })
      continue
    }
    events.push({ at: now, kind: 'signed', params: { signature } })
    if (outcome.evidence.status === 'unknown') events.push({ at: now, kind: 'unknown' })
    sent = true
  }
  return {
    ...incident,
    state: sent ? 'awaiting-confirmation' : 'open',
    events: [...incident.events, ...events],
    evidence: [...incident.evidence, ...evidence],
  }
}

/**
 * Resolução exige leitura nova de todos os ativos afetados, elegíveis no mesmo ciclo.
 * Leitura desconhecida nunca resolve nem reabre: o operador consulta de novo.
 */
export function applyVerification(incident: DeskIncident, snapshots: DeskSnapshot[], now: string): DeskIncident {
  if (incident.state === 'resolved') return incident
  const slot = Math.max(0, ...snapshots.map((s) => s.read.slot))
  if (snapshots.length === 0 || snapshots.some((s) => s.verdict === 'unknown')) {
    return { ...incident, events: [...incident.events, { at: now, kind: 'unknown' }] }
  }
  if (snapshots.every((s) => s.verdict === 'eligible')) {
    return {
      ...incident,
      state: 'resolved',
      observed: false,
      resolvedSlot: slot,
      events: [...incident.events, { at: now, kind: 'resolved', params: { slot: String(slot) } }],
      evidence: [...incident.evidence, { status: 'confirmed', slot, logs: [], readback: snapshots }],
    }
  }
  const blocking = snapshots.flatMap((s) => s.reasons.filter((r) => !r.hint))[0]
  return {
    ...incident,
    state: 'open',
    events: [...incident.events, { at: now, kind: 'stillBlocked', params: { code: blocking?.code ?? '' } }],
  }
}
