import type { IncidentState } from '@aveo/contracts'
import { useQueryClient } from '@tanstack/react-query'
import type { Address as SolanaAddress } from '@solana/kit'
import { useState } from 'react'
import type { DeskPlan } from '../../api/backend'
import { checkPayload } from '../../api/eligibility'
import type { ProofRow } from '../../api/inventory'
import { useReadyDesk } from '../../app/desk'
import { Address } from '../../components/Address'
import { formatExpiry, formatSlot, shortAddress } from '../../components/format'
import { ReasonList } from '../../components/reasons'
import { Badge, Card, ErrorState, Spinner } from '../../components/ui'
import { useI18n } from '../../i18n/context'
import { useWallet } from '../../wallet/context'
import { useAssetsQuery, useClockQuery, useProofsQuery } from '../assets/queries'
import { EvidenceView } from '../operations/EvidenceView'
import { labelFor } from '../operations/labels'
import { SimulationSummary } from '../operations/SimulationSummary'
import { runPlan } from '../operations/useExecutePlan'
import { applySends, applyVerification, markPrepared, type DeskIncident, type SendOutcome } from './model'
import { useIncidentStore } from './store'

const STATES: IncidentState[] = ['open', 'action-prepared', 'awaiting-confirmation', 'resolved']
const STATE_TONE = { open: 'bad', 'action-prepared': 'warn', 'awaiting-confirmation': 'accent', resolved: 'ok' } as const

/** Prova nova da mesma carteira, aceita pela política do ativo e válida no relógio da rede. */
function useCandidates(incident: DeskIncident) {
  const proofs = useProofsQuery()
  const assets = useAssetsQuery()
  const clock = useClockQuery()
  const loading = proofs.isPending || assets.isPending || clock.isPending
  const candidates = incident.affectedMints.map((mint) => {
    const policy = assets.data?.assets.find((a) => a.asset.mint === mint)?.policy
    let proof: ProofRow | undefined
    if (policy && clock.data) {
      proof = proofs.data?.find(
        (p) =>
          p.wallet === incident.wallet &&
          p.address !== incident.proof &&
          policy.pairs.some((pair) => pair.credential === p.attestation.credential && pair.schema === p.attestation.schema) &&
          checkPayload(policy, incident.wallet as SolanaAddress, p.attestation, clock.data.unix).reasons.length === 0,
      )
    }
    return { mint, proof }
  })
  return { loading, candidates, clockUnix: clock.data?.unix }
}

export function IncidentCard({ incident }: { incident: DeskIncident }) {
  const { t, locale } = useI18n()
  const { backend, ctx, deployment } = useReadyDesk()
  const { connected } = useWallet()
  const queryClient = useQueryClient()
  const { patch } = useIncidentStore()
  const { loading, candidates, clockUnix } = useCandidates(incident)
  const [plans, setPlans] = useState<{ mint: string; plan: DeskPlan }[]>([])
  const [busy, setBusy] = useState<'prepare' | 'sign' | 'verify'>()
  const [actionError, setActionError] = useState<unknown>()

  const resolved = incident.state === 'resolved'
  const walletLabel = labelFor(deployment, incident.wallet)
  const walletId = deployment.wallets.find((w) => w.address === incident.wallet)?.id
  const rebindable = candidates.filter(
    (c): c is { mint: string; proof: ProofRow } => c.proof !== undefined && !c.proof.boundTo.includes(c.mint as SolanaAddress),
  )
  const signable = plans.filter((p) => p.plan.simulation.ok)
  const isSigner = connected?.address === incident.wallet
  const stateIndex = STATES.indexOf(incident.state)
  const now = () => new Date().toISOString()

  const prepare = async () => {
    setBusy('prepare')
    setActionError(undefined)
    try {
      const built = await Promise.all(
        rebindable.map(async ({ mint, proof }) => ({
          mint,
          plan: await backend.planRenewBinding({ cluster: ctx.cluster, mint, wallet: incident.wallet, attestation: proof.address }),
        })),
      )
      setPlans(built)
      patch(incident.id, (i) => markPrepared(i, built.length, now()))
    } catch (error) {
      setActionError(error)
    } finally {
      setBusy(undefined)
    }
  }

  // Um set_binding por ativo: o contrato de renovação é por mint.
  const sign = async () => {
    if (!connected || !isSigner) return
    setBusy('sign')
    const outcomes: SendOutcome[] = []
    for (const { plan } of signable) {
      const result = await runPlan(ctx, backend, connected.signer, plan)
      outcomes.push('error' in result ? { error: result.error } : { evidence: result.evidence })
    }
    patch(incident.id, (i) => applySends(i, outcomes, now()))
    setPlans([])
    setBusy(undefined)
    await queryClient.invalidateQueries()
  }

  const verify = async () => {
    setBusy('verify')
    setActionError(undefined)
    try {
      const snapshots = await Promise.all(incident.affectedMints.map((mint) => backend.inspect({ cluster: ctx.cluster, mint, wallet: incident.wallet })))
      patch(incident.id, (i) => applyVerification(i, snapshots, now()))
      await queryClient.invalidateQueries()
    } catch (error) {
      setActionError(error)
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <Card
      title={`${t(`incidentType.${incident.type}`)} · ${walletLabel}`}
      aside={<Badge tone={STATE_TONE[incident.state]}>{t(`incidentState.${incident.state}`)}</Badge>}
    >
      <ol className="stepper">
        {STATES.map((state, i) => (
          <li key={state} className={i < stateIndex || resolved ? 'done' : i === stateIndex ? 'current' : ''}>
            {t(`incidentState.${state}`)}
          </li>
        ))}
      </ol>

      <div className="incident-meta">
        <span className="small">
          {t('incidents.detected', { slot: formatSlot(locale, incident.detectedSlot), time: new Date(incident.detectedAt).toLocaleString(locale) })}
        </span>
        <span className="small">
          {t('incidents.proof')}: <Address value={incident.proof} short />
        </span>
      </div>

      <h3>{t('incidents.cause')}</h3>
      <ReasonList reasons={[incident.cause]} showDetail />

      <h3>
        {t('incidents.affected')} <span className="small muted">({t('incidents.hint')})</span>
      </h3>
      <div className="affected">
        {incident.affectedMints.map((mint) => {
          const candidate = candidates.find((c) => c.mint === mint)?.proof
          const asset = labelFor(deployment, mint)
          return (
            <div className="affected-item" key={mint}>
              <strong>{asset}</strong>
              {!resolved && incident.type !== 'READ_UNVERIFIABLE' && !loading && (
                <span className={`small ${candidate ? 'ok-text' : 'muted'}`}>
                  {candidate && clockUnix !== undefined
                    ? t(candidate.boundTo.includes(mint as SolanaAddress) ? 'incidents.newProofBound' : 'incidents.newProof', {
                        asset,
                        verifier: labelFor(deployment, candidate.attestation.credential),
                        expiry: formatExpiry(t, candidate.attestation.expiry, clockUnix),
                      })
                    : t('incidents.noCandidate', { asset })}
                </span>
              )}
            </div>
          )
        })}
      </div>

      {resolved && incident.resolvedSlot !== undefined && (
        <p className="small ok-text">{t('incidents.resolvedAt', { slot: formatSlot(locale, incident.resolvedSlot) })}</p>
      )}

      {!resolved && (
        <>
          {!incident.observed && <p className="small warn-text">{t('incidents.notObserved')}</p>}
          {incident.type === 'READ_UNVERIFIABLE' ? (
            <p className="small">{t('incidents.readOnly')}</p>
          ) : (
            !loading &&
            candidates.some((c) => !c.proof) && (
              <div className="box">
                <p className="small">{t('incidents.waitingProof')}</p>
                {ctx.cluster === 'localnet' && walletId && (
                  <p className="small muted">
                    <code>{t('incidents.waitingProofDev', { wallet: walletId })}</code>
                  </p>
                )}
                {(incident.type === 'PROVIDER_REMOVED' || incident.type === 'POLICY_CHANGED') && <p className="small muted">{t('incidents.providerNote')}</p>}
              </div>
            )
          )}

          {plans.length > 0 && (
            <div className="box">
              {plans.map(({ mint, plan }) => (
                <SimulationSummary key={mint} plan={plan} title={labelFor(deployment, mint)} />
              ))}
              <div className="actions">
                <button type="button" className="primary" disabled={signable.length === 0 || !isSigner || busy !== undefined} onClick={() => void sign()}>
                  {busy === 'sign' && <Spinner />} {t('incidents.sign', { wallet: walletLabel })}
                </button>
                <span className="small muted">{t('wallet.required', { wallet: walletLabel })}</span>
                {connected && !isSigner && <span className="small warn-text">{t('wallet.wrong', { wallet: walletLabel })}</span>}
              </div>
            </div>
          )}

          <div className="actions">
            {incident.type !== 'READ_UNVERIFIABLE' && rebindable.length > 0 && (
              <button type="button" disabled={busy !== undefined} onClick={() => void prepare()}>
                {busy === 'prepare' && <Spinner />} {t('incidents.prepare')}
              </button>
            )}
            <button type="button" disabled={busy !== undefined} onClick={() => void verify()}>
              {busy === 'verify' && <Spinner />} {t('incidents.verify')}
            </button>
          </div>
          {actionError !== undefined && <ErrorState error={actionError} />}
        </>
      )}

      <details>
        <summary>{t('incidents.history', { n: incident.events.length })}</summary>
        <ol className="timeline">
          {incident.events.map((event, i) => (
            <li key={i}>
              <span className="small muted">{new Date(event.at).toLocaleString(locale)}</span>
              <span className="small">
                {t(`event.${event.kind}`, {
                  ...event.params,
                  ...(event.params?.signature ? { signature: shortAddress(event.params.signature) } : {}),
                  ...(event.params?.slot ? { slot: formatSlot(locale, Number(event.params.slot)) } : {}),
                })}
              </span>
            </li>
          ))}
        </ol>
      </details>

      {incident.evidence.length > 0 && (
        <details>
          <summary>
            {t('incidents.evidence')} ({incident.evidence.length})
          </summary>
          {incident.evidence.map((evidence, i) => (
            <EvidenceView key={i} evidence={evidence} labelOf={(a) => labelFor(deployment, a)} />
          ))}
        </details>
      )}
    </Card>
  )
}
