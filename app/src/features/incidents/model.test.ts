// Agrupamento, deduplicação e resolução dos incidentes (spec v3, seção 8 e casos T05/T06).
import type { Verdict } from '@aveo/contracts'
import { getBase58Decoder } from '@solana/kit'
import { describe, expect, it } from 'vitest'
import type { DeskSnapshot, ReasonCode } from '../../api/diagnostics'
import { EMPTY_STORE, applyScan, applySends, applyVerification, findIncidents, markPrepared } from './model'
import { applySignatureRecheck } from './confirmation-model'
import { canPrepareRenewal } from './renewal'

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

  it('prova que a política nunca aceitou não abre incidente', () => {
    const { findings } = findIncidents(
      [snap(BETA, 'wallet-y', 'ineligible', 'ProviderPairNotAllowed', 'proof-y'), snap(BETA, 'wallet-z', 'ineligible', 'RequiredFactMissing', 'proof-z')],
      {},
    )
    expect(findings).toEqual([])
  })

  it('par removido depois de elegível abre PROVIDER_REMOVED', () => {
    const watched = { [`${ALFA}:${X}`]: PROOF }
    const { findings } = findIncidents([snap(ALFA, X, 'ineligible', 'ProviderPairNotAllowed', PROOF)], watched)
    expect(findings).toMatchObject([{ type: 'PROVIDER_REMOVED', proof: PROOF }])
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

  it.each([
    { error: { code: 'ConfirmationUnknown' as const, message: 'Unknown submission' }, sendBlocked: true },
    { error: { code: 'ConfirmationUnknown' as const, message: 'Unknown submission' } },
    { error: { code: 'SimulationFailed' as const, message: 'Unknown submission' }, sendBlocked: true },
    { evidence: { status: 'unknown' as const, logs: [] } },
  ])('keeps signatureless ambiguity pending without refusal or fabricated signing: %j', (outcome) => {
    const pending = applySends(markPrepared(opened, 2, NOW), [outcome], NOW)
    expect(pending.state).toBe('awaiting-confirmation')
    expect(pending.evidence).toMatchObject([{ status: 'unknown' }])
    expect(pending.evidence[0]?.signature).toBeUndefined()
    if ('error' in outcome) expect(pending.evidence[0]?.error?.code).toBe('ConfirmationUnknown')
    expect(pending.events.some((event) => event.kind === 'sendFailed' || event.kind === 'signed')).toBe(false)
    expect(pending.events.at(-1)?.kind).toBe('submissionUnknown')
    expect(canPrepareRenewal(pending)).toBe(false)
    expect(markPrepared(pending, 2, NOW)).toBe(pending)
    // A later refusal must not overwrite an earlier unresolved submission.
    const refused = applySends(pending, [{ error: { code: 'SimulationFailed', message: 'Rejected' } }], NOW)
    expect(refused.state).toBe('awaiting-confirmation')
    expect(refused.evidence).toEqual(pending.evidence)
    for (const verdict of ['eligible', 'ineligible', 'unknown'] as const) {
      const snapshots = [snap(ALFA, X, verdict, undefined, 'new-proof', 140), snap(BETA, X, verdict, undefined, 'new-proof', 140)]
      const checked = applyVerification(pending, snapshots, NOW)
      expect(checked.state).toBe('awaiting-confirmation')
      expect(checked.resolvedSlot).toBeUndefined()
      expect(checked.evidence).toEqual(pending.evidence)
      const rescanned = applyScan({ ...EMPTY_STORE, incidents: [checked] }, snapshots, 140, NOW).incidents[0]!
      expect(canPrepareRenewal(rescanned)).toBe(false)
      expect(markPrepared(rescanned, 2, NOW)).toBe(rescanned)
    }
  })

  it.each(['confirmed', 'failed'] as const)('preserves supported known-signature %s recovery and retains unrelated signatureless guards', (status) => {
    const signature = getBase58Decoder().decode(new Uint8Array(64).fill(9))
    const pending = applySends(opened, [{ evidence: { status: 'unknown', signature, logs: [] } }], NOW)
    const recovered = applySignatureRecheck(pending, pending, { status, signature, slot: 120, logs: [] }, NOW)
    expect(recovered.evidence).toMatchObject([{ status, signature }])
    if (status === 'failed') expect(canPrepareRenewal(recovered)).toBe(true)
    const snapshots = [snap(ALFA, X, 'eligible', undefined, 'new-proof', 140), snap(BETA, X, 'eligible', undefined, 'new-proof', 140)]
    expect(applyVerification(recovered, snapshots, NOW).state).toBe('resolved')

    const mixed = applySends(pending, [{ error: { code: 'ConfirmationUnknown', message: 'Unknown submission' } }], NOW)
    const mixedRecovered = applySignatureRecheck(mixed, mixed, { status, signature, slot: 120, logs: [] }, NOW)
    expect(mixedRecovered.evidence.find((item) => item.signature === signature)?.status).toBe(status)
    expect(canPrepareRenewal(mixedRecovered)).toBe(false)
    expect(applyVerification(mixedRecovered, snapshots, NOW).state).toBe('awaiting-confirmation')
  })

  it('blocks a late signatureless submission even if eligibility was already resolved', () => {
    const resolved = applyVerification(opened, [snap(ALFA, X, 'eligible', undefined, 'new-proof', 140), snap(BETA, X, 'eligible', undefined, 'new-proof', 140)], NOW)
    const pending = applySends(resolved, [{ error: { code: 'ConfirmationUnknown', message: 'Unknown submission' } }], NOW)
    expect(pending.state).toBe('awaiting-confirmation')
    expect(pending.resolvedSlot).toBeUndefined()
    expect(canPrepareRenewal(pending)).toBe(false)
  })

  it.each([
    { error: { code: 'SimulationFailed' as const, message: 'Rejected' } },
    { evidence: { status: 'failed' as const, signature: 'other', logs: [] } },
    { evidence: { status: 'confirmed' as const, signature: 'other', slot: 120, logs: [] } },
    { evidence: { status: 'unknown' as const, signature: 'other', logs: [] } },
  ])('retains an existing unknown signature after an unrelated send outcome: %j', (outcome) => {
    const pending = applySends(opened, [{ evidence: { status: 'unknown', signature: 'original', logs: [] } }], NOW)
    const result = applySends(pending, [outcome], NOW)
    expect(result.state).toBe('awaiting-confirmation')
    expect(result.evidence).toContain(pending.evidence[0])
    expect(canPrepareRenewal(result)).toBe(false)
    expect(markPrepared(result, 2, NOW)).toBe(result)
  })

  it.each(['confirmed', 'failed', 'unknown'] as const)('reconciles provisional signature evidence with a later %s outcome', (status) => {
    const pending = applySends(opened, [{ evidence: { status: 'unknown', signature: 'original', logs: [] } }], NOW)
    const retained = { status: 'confirmed' as const, signature: 'other', slot: 110, logs: [] }
    const result = applySends({ ...pending, evidence: [...pending.evidence, retained] }, [{ evidence: {
      status, signature: 'original', slot: status === 'unknown' ? undefined : 120, logs: ['verified'],
    } }], NOW)
    expect(result.evidence.filter((item) => item.signature === 'original')).toHaveLength(1)
    expect(result.evidence.find((item) => item.signature === 'original')).toMatchObject({ status, logs: ['verified'] })
    expect(result.evidence).toContain(retained)
    expect(result.events.filter((event) => event.kind === 'signed' && event.params?.signature === 'original')).toHaveLength(1)
    expect(result.events.filter((event) => event.kind === 'unknown')).toHaveLength(1)
    expect(result.state).toBe(status === 'failed' ? 'open' : 'awaiting-confirmation')
    expect(pending.evidence[0]?.status).toBe('unknown')
  })

  it.each(['confirmed', 'failed', 'unknown'] as const)('retains a resolved incident when a late %s send completes', (status) => {
    const resolved = applyVerification(opened, [snap(ALFA, X, 'eligible', undefined, 'new-proof', 130), snap(BETA, X, 'eligible', undefined, 'new-proof', 130)], NOW)
    const result = applySends(resolved, [{ evidence: { status, signature: 'late', logs: [] } }], NOW)
    expect(result.state).toBe('resolved')
    expect(result.resolvedSlot).toBe(130)
    expect(result.observed).toBe(false)
    expect(result.evidence[0]).toBe(resolved.evidence[0])
    expect(result.evidence.at(-1)?.signature).toBe('late')
  })

  it('retains resolution and evidence when a late wallet rejection completes', () => {
    const resolved = applyVerification(opened, [snap(ALFA, X, 'eligible', undefined, 'new-proof', 130), snap(BETA, X, 'eligible', undefined, 'new-proof', 130)], NOW)
    const result = applySends(resolved, [{ error: { code: 'SimulationFailed', message: 'Rejected' } }], NOW)
    expect(result.state).toBe('resolved')
    expect(result.resolvedSlot).toBe(130)
    expect(result.evidence).toEqual(resolved.evidence)
    expect(result.events.at(-1)?.kind).toBe('sendFailed')
  })

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

  it('keeps an incident open when the readback omits an affected asset', () => {
    const checked = applyVerification(opened, [snap(ALFA, X, 'eligible', undefined, 'proof-new', 140)], NOW)
    expect(checked.state).toBe('open')
    expect(checked.events.at(-1)?.kind).toBe('unknown')
    expect(checked.evidence).toEqual(opened.evidence)
  })

  it('rejects duplicate assets and readbacks for another wallet', () => {
    const readbacks = [
      [snap(ALFA, X, 'eligible'), snap(ALFA, X, 'eligible')],
      [snap(ALFA, X, 'eligible'), snap(BETA, 'wallet-y', 'eligible')],
      [snap(ALFA, X, 'eligible'), snap('other-mint', X, 'eligible')],
    ]
    for (const snapshots of readbacks) {
      const checked = applyVerification(opened, snapshots, NOW)
      expect(checked.state).toBe('open')
      expect(checked.events.at(-1)?.kind).toBe('unknown')
    }
  })

  it('rejects reads older than detection or a confirmed correction', () => {
    const stale = applyVerification(opened, [snap(ALFA, X, 'eligible', undefined, PROOF, 99), snap(BETA, X, 'eligible')], NOW)
    expect(stale.state).toBe('open')
    const sent = applySends(opened, [{ evidence: { status: 'confirmed', signature: 'sig', slot: 150, logs: [] } }], NOW)
    const checked = applyVerification(sent, [snap(ALFA, X, 'eligible', undefined, 'proof-new', 149), snap(BETA, X, 'eligible', undefined, 'proof-new', 151)], NOW)
    expect(checked.state).toBe('awaiting-confirmation')
    expect(checked.events.at(-1)?.kind).toBe('unknown')
  })

  it('rejects a readback assembled from different networks or RPCs', () => {
    const alfa = snap(ALFA, X, 'eligible')
    const beta = snap(BETA, X, 'eligible')
    for (const read of [
      { ...beta.read, cluster: 'devnet' as const },
      { ...beta.read, rpcUrl: 'http://127.0.0.1:9999' },
      { ...beta.read, commitment: 'processed' as const },
    ]) {
      const checked = applyVerification(opened, [alfa, { ...beta, read }], NOW)
      expect(checked.state).toBe('open')
      expect(checked.events.at(-1)?.kind).toBe('unknown')
    }
  })

  it('incidente resolvido não volta a abrir: o mesmo problema depois é um incidente novo', () => {
    const resolved = applyVerification(opened, [snap(ALFA, X, 'eligible', undefined, PROOF), snap(BETA, X, 'eligible', undefined, PROOF)], NOW)
    const data = applyScan({ ...EMPTY_STORE, incidents: [resolved] }, [snap(ALFA, X, 'ineligible', 'AttestationExpired', PROOF, 200)], 200, NOW)
    expect(data.incidents.map((i) => i.state)).toEqual(['resolved', 'open'])
  })
})
