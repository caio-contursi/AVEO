import type { IncidentState } from '@aveo/contracts'
import { useQueryClient } from '@tanstack/react-query'
import type { Address as SolanaAddress } from '@solana/kit'
import { useLayoutEffect, useRef, useState } from 'react'
import type { DeskPlan } from '../../api/backend'
import { checkPayload } from '../../api/eligibility'
import type { DeskSnapshot } from '../../api/diagnostics'
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
import { getSubmissionJournal } from '../operations/submission-journal'
import { applySends, applyVerification, markPrepared, type DeskIncident, type SendOutcome } from './model'
import { useIncidentStore } from './store'
import { usePlanPreparation } from '../operations/usePlanPreparation'
import { canPrepareRenewal, groupRenewalCandidates, hasPendingRenewal, sameRenewalIntent } from './renewal'

const STATES: IncidentState[] = ['open', 'action-prepared', 'awaiting-confirmation', 'resolved']
const STATE_TONE = { open: 'bad', 'action-prepared': 'warn', 'awaiting-confirmation': 'accent', resolved: 'ok' } as const
type RenewalReview = { key: string; title: string; plan: DeskPlan }
const NO_PLANS: RenewalReview[] = []

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
  const policies = incident.affectedMints.map((mint) => {
    const policy = assets.data?.assets.find((asset) => asset.asset.mint === mint)?.policy
    return [mint, policy?.policyVersion?.toString(), policy?.active]
  })
  return { loading, candidates, policies, clockUnix: clock.data?.unix }
}

export function IncidentCard({ incident }: { incident: DeskIncident }) {
  const { t, locale } = useI18n()
  const { backend, ctx, deployment } = useReadyDesk()
  const { connected } = useWallet()
  const queryClient = useQueryClient()
  const { patch } = useIncidentStore()
  const { loading, candidates, policies, clockUnix } = useCandidates(incident)
  const [actionBusy, setActionBusy] = useState<'sign' | 'verify'>()
  const [actionError, setActionError] = useState<unknown>()
  const [journalError, setJournalError] = useState(false)
  const mounted = useRef(false)
  const actionLock = useRef(false)
  useLayoutEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const resolved = incident.state === 'resolved'
  const walletLabel = labelFor(deployment, incident.wallet)
  const walletId = deployment.wallets.find((w) => w.address === incident.wallet)?.id
  const rebindable = candidates.filter(
    (c): c is { mint: string; proof: ProofRow } => c.proof !== undefined && !c.proof.boundTo.includes(c.mint as SolanaAddress),
  )
  const pendingRenewal = hasPendingRenewal(incident)
  const preparation = usePlanPreparation<RenewalReview[]>([
    ctx.cluster, ctx.rpcUrl, ctx.programId, ctx.commitment, ctx.deployment, connected?.address,
    incident.id, incident.key, incident.type, incident.wallet, incident.proof, incident.affectedMints,
    incident.observed, incident.state === 'resolved',
    actionBusy === 'sign' && !resolved ? true : canPrepareRenewal(incident), loading,
    policies,
    rebindable.map(({ mint, proof }) => [mint, proof.address]),
  ])
  const verification = usePlanPreparation<DeskSnapshot[]>([
    ctx.cluster, ctx.rpcUrl, ctx.programId, ctx.commitment, ctx.deployment,
    incident.id, incident.wallet, incident.proof, incident.affectedMints, incident.state,
    incident.evidence.map((item) => [item.signature, item.status, item.slot]),
  ])
  const plans = preparation.plan ?? NO_PLANS
  const busy = actionBusy ?? (preparation.planning ? 'prepare' : undefined)
  const signable = plans.filter((p) => p.plan.simulation.ok)
  const isSigner = connected?.address === incident.wallet
  const stateIndex = STATES.indexOf(incident.state)
  const now = () => new Date().toISOString()

  const prepare = async () => {
    if (actionLock.current || loading || !canPrepareRenewal(incident) || rebindable.length === 0) return
    setActionError(undefined)
    const built = await preparation.prepare(async () => {
      const groups = groupRenewalCandidates(rebindable)
      return Promise.all(
        groups.map(async ({ key, attestation, mints }) => ({
          key,
          title: mints.map((mint) => labelFor(deployment, mint)).join(' + '),
          plan: await backend.planRenewBinding({
            cluster: ctx.cluster,
            mint: mints[0]!,
            mints,
            wallet: incident.wallet,
            attestation,
          }),
        })),
      )
    })
    if (!built || !preparation.isCurrent(built)) return
    const assetCount = new Set(rebindable.map((item) => item.mint)).size
    let accepted = false
    try {
      patch(incident.id, (current) => {
        if (!sameRenewalIntent(current, incident) || !preparation.isCurrent(built)) return current
        accepted = true
        return markPrepared(current, assetCount, now())
      })
    } catch {
      preparation.clear()
      if (mounted.current) setActionError(new Error(t('operations.prepareFailed')))
      return
    }
    if (!accepted && preparation.isCurrent(built)) preparation.clear()
  }

  // One transaction per proof; context changes stop groups not yet submitted.
  const sign = async () => {
    if (actionLock.current || !connected || !isSigner || !canPrepareRenewal(incident) ||
      signable.length === 0 || !preparation.isCurrent(plans)) return
    actionLock.current = true
    setActionBusy('sign')
    const outcomes: SendOutcome[] = []
    try {
      for (const { plan } of signable) {
        if (!preparation.isCurrent(plans)) break
        const result = await runPlan(ctx, backend, connected.signer, plan, {
          onSent: (signature) => {
            try {
              patch(incident.id, (current) => applySends(current, [{ evidence: { status: 'unknown', signature, logs: [] } }], now()))
            } catch {
              if (mounted.current) setJournalError(true)
            }
            // Keep grouped renewal signatures recoverable, even after leaving this card.
            try {
              const journal = getSubmissionJournal()
              void journal.capture(ctx, signature).then(() => {
                if (mounted.current) setJournalError(journal.error !== undefined)
              }).catch(() => {
                if (mounted.current) setJournalError(true)
              })
            } catch {
              if (mounted.current) setJournalError(true)
            }
          },
        })
        outcomes.push('error' in result ? { error: result.error } : { evidence: result.evidence })
        if (!('error' in result) && result.evidence.status === 'unknown') break
      }
    } catch {
      if (mounted.current) setActionError(new Error(t('incidents.verifyFailed')))
    } finally {
      // Submission evidence belongs to the captured store even after leaving this screen.
      try {
        if (outcomes.length > 0) patch(incident.id, (current) => applySends(current, outcomes, now()))
      } catch {
        if (mounted.current) setActionError(new Error(t('incidents.verifyFailed')))
      }
      preparation.clear()
      actionLock.current = false
      if (mounted.current) setActionBusy(undefined)
    }
    try { await queryClient.invalidateQueries() } catch {
      if (mounted.current) setActionError(new Error(t('incidents.verifyFailed')))
    }
  }

  const verify = async () => {
    if (actionLock.current || !mounted.current) return
    actionLock.current = true
    preparation.clear()
    setActionBusy('verify')
    setActionError(undefined)
    try {
      const snapshots = await verification.prepare(() => Promise.all(incident.affectedMints.map((mint) => backend.inspect({ cluster: ctx.cluster, mint, wallet: incident.wallet }))))
      if (!snapshots || !verification.isCurrent(snapshots)) return
      patch(incident.id, (i) => applyVerification(i, snapshots, now()))
      await queryClient.invalidateQueries()
    } catch {
      if (mounted.current) setActionError(new Error(t('incidents.verifyFailed')))
    } finally {
      actionLock.current = false
      if (mounted.current) setActionBusy(undefined)
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
      {journalError && <p className="warn-text" role="alert">{t('receipts.storage-unavailable')}</p>}

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
              {plans.map(({ key, title, plan }) => (
                <SimulationSummary key={key} plan={plan} title={title} />
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
            {canPrepareRenewal(incident) && rebindable.length > 0 && !loading && (
              <button type="button" disabled={busy !== undefined} onClick={() => void prepare()}>
                {busy === 'prepare' && <Spinner />} {t('incidents.prepare')}
              </button>
            )}
            <button type="button" disabled={busy !== undefined} onClick={() => void verify()}>
              {busy === 'verify' && <Spinner />} {t('incidents.verify')}
            </button>
          </div>
          {pendingRenewal && <p className="small warn-text" role="alert">{t('incidents.pendingRenewal')}</p>}
          {preparation.error && <p className="small warn-text" role="alert">{t('operations.prepareFailed')}</p>}
          {verification.error && <p className="small warn-text" role="alert">{t('incidents.verifyFailed')}</p>}
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
