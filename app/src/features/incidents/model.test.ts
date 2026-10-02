// Agrupamento, deduplicação e resolução dos incidentes (spec v3, seção 8 e casos T05/T06).
import type { Verdict } from '@aveo/contracts'
import { describe, expect, it } from 'vitest'
import type { DeskSnapshot, ReasonCode } from '../../api/diagnostics'
import { EMPTY_STORE, applyScan, applySends, applyVerification, findIncidents, markPrepared } from './model'

const ALFA = 'alfa-mint'
const BETA = 'beta-mint'
const X = 'wallet-x'
const PROOF = 'proof-x'
const NOW = '2026-10-02T03:45:00.000Z'

function snap(mint: string, wallet: string, verdict: Verdict, code?: ReasonCode, attestation?: string, slot = 100): DeskSnapshot {
  return {
    backend: 'aveo-sas-hook',
    read: { cluster: 'localnet', rpcUrl: 'http://127.0.0.1:8899', slot, commitment: 'confirmed', observedAt: NOW },
    mint,
    wallet,
    verdict,
    reasons: code ? [{ code, message: code }] : [],
    sourceAccounts: { attestation },
    actions: [],
  }
}

describe('scan:once', () => {
  it('agrupa os dois ativos de uma prova vencida num único incidente', () => {
    const data = applyScan(EMPTY_STORE, [snap(ALFA, X, 'ineligible', 'AttestationExpired', PROOF), snap(BETA, X, 'ineligible', 'AttestationExpired', PROOF)], 100, NOW)
    expect(data.incidents).toHaveLength(1)
    expect(data.incidents[0]).toMatchObject({ type: 'PROOF_EXPIRED', state: 'open', wallet: X, proof: PROOF, affectedMints: [ALFA, BETA], detectedSlot: 100 })
  })

  it('repetir o scan (ou recarregar a página) não duplica o incidente', () => {
    const snapshots = [snap(ALFA, X, 'ineligible', 'AttestationMissingOrClosed', PROOF)]
    const first = applyScan(EMPTY_STORE, snapshots, 100, NOW)
    const second = applyScan(JSON.parse(JSON.stringify(first)), [...snapshots, snap(BETA, X, 'ineligible', 'AttestationMissingOrClosed', PROOF, 120)], 120, NOW)
    expect(second.incidents).toHaveLength(1)
    expect(second.incidents[0]!.affectedMints).toEqual([ALFA, BETA])
    expect(second.incidents[0]!.detectedSlot).toBe(100)
  })

  it('carteira sem vínculo não é incidente', () => {
    const { findings } = findIncidents([snap(BETA, 'wallet-y', 'ineligible', 'BindingMissing')], {})
    expect(findings).toEqual([])
  })

  it('leitura desconhecida só abre READ_UNVERIFIABLE para vínculo já visto', () => {
    expect(findIncidents([snap(ALFA, X, 'unknown', 'ReadUnverifiable')], {}).findings).toEqual([])
    const watched = findIncidents([snap(ALFA, X, 'eligible', undefined, PROOF)], {}).watched
    const { findings } = findIncidents([snap(ALFA, X, 'unknown', 'ReadUnverifiable')], watched)
    expect(findings).toMatchObject([{ type: 'READ_UNVERIFIABLE', proof: PROOF }])
  })

  it('política inativa usa a última prova vista, já que o hook para antes de ler o binding', () => {
    const watched = { [`${ALFA}:${X}`]: PROOF }
    const { findings } = findIncidents([snap(ALFA, X, 'ineligible', 'PolicyMissingOrInactive')], watched)
    expect(findings).toMatchObject([{ type: 'POLICY_CHANGED', proof: PROOF }])
  })

  it('incidente fora do último scan fica marcado, mas continua aberto', () => {
    const first = applyScan(EMPTY_STORE, [snap(ALFA, X, 'ineligible', 'AttestationExpired', PROOF)], 100, NOW)
    const second = applyScan(first, [snap(ALFA, X, 'eligible', undefined, 'proof-new')], 130, NOW)
    expect(second.incidents[0]).toMatchObject({ state: 'open', observed: false })
  })
})

describe('ciclo do incidente', () => {
  const opened = applyScan(EMPTY_STORE, [snap(ALFA, X, 'ineligible', 'AttestationExpired', PROOF), snap(BETA, X, 'ineligible', 'AttestationExpired', PROOF)], 100, NOW)
    .incidents[0]!

  it('envio recusado mantém o incidente aberto', () => {
    const prepared = markPrepared(opened, 2, NOW)
    expect(prepared.state).toBe('action-prepared')
    const failed = applySends(prepared, [{ error: { code: 'RequiredFactMissing', message: 'x' } }], NOW)
    expect(failed.state).toBe('open')
    expect(failed.events.at(-1)).toMatchObject({ kind: 'sendFailed', params: { code: 'RequiredFactMissing' } })
  })

  it('só resolve com leitura nova elegível em todos os ativos afetados', () => {
    const sent = applySends(markPrepared(opened, 2, NOW), [{ evidence: { status: 'confirmed', signature: 'sig', logs: [] } }], NOW)
    expect(sent.state).toBe('awaiting-confirmation')
    const partial = applyVerification(sent, [snap(ALFA, X, 'eligible', undefined, 'proof-new', 140), snap(BETA, X, 'ineligible', 'AttestationExpired', PROOF, 140)], NOW)
    expect(partial.state).toBe('open')
    const resolved = applyVerification(sent, [snap(ALFA, X, 'eligible', undefined, 'proof-new', 140), snap(BETA, X, 'eligible', undefined, 'proof-new', 141)], NOW)
    expect(resolved).toMatchObject({ state: 'resolved', resolvedSlot: 141 })
    expect(resolved.evidence.at(-1)?.readback).toHaveLength(2)
  })

  it('confirmação desconhecida nunca resolve', () => {
    const sent = applySends(markPrepared(opened, 2, NOW), [{ evidence: { status: 'unknown', signature: 'sig', logs: [] } }], NOW)
    expect(sent.state).toBe('awaiting-confirmation')
    const checked = applyVerification(sent, [snap(ALFA, X, 'unknown', 'ReadUnverifiable'), snap(BETA, X, 'eligible', undefined, 'proof-new')], NOW)
    expect(checked.state).toBe('awaiting-confirmation')
    expect(checked.events.at(-1)?.kind).toBe('unknown')
  })

  it('incidente resolvido não volta a abrir: o mesmo problema depois é um incidente novo', () => {
    const resolved = applyVerification(opened, [snap(ALFA, X, 'eligible', undefined, PROOF), snap(BETA, X, 'eligible', undefined, PROOF)], NOW)
    const data = applyScan({ ...EMPTY_STORE, incidents: [resolved] }, [snap(ALFA, X, 'ineligible', 'AttestationExpired', PROOF, 200)], 200, NOW)
    expect(data.incidents.map((i) => i.state)).toEqual(['resolved', 'open'])
  })
})
