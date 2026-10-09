import type { DeskPlan } from '../../api/backend'
import type { DeskSnapshot } from '../../api/diagnostics'
import type { ProofRow } from '../../api/inventory'
import { useReadyDesk } from '../../app/desk'
import { Spinner } from '../../components/ui'
import { useI18n } from '../../i18n/context'
import { useWallet } from '../../wallet/context'
import { EvidenceView } from '../operations/EvidenceView'
import { labelFor } from '../operations/labels'
import { PlanReview } from '../operations/PlanReview'
import { useExecutePlan } from '../operations/useExecutePlan'
import { usePlanPreparation } from '../operations/usePlanPreparation'

/**
 * Vincula uma prova válida e aceita pela política (set_binding). A própria carteira assina:
 * o Desk só monta e simula (spec v3, seção 6.3).
 */
export function BindProofAction({ snapshot, proof }: { snapshot: DeskSnapshot; proof: ProofRow }) {
  const { t } = useI18n()
  const { backend, ctx, deployment } = useReadyDesk()
  const { connected } = useWallet()
  const preparation = usePlanPreparation<DeskPlan>([
    ctx.cluster, ctx.rpcUrl, ctx.programId, ctx.commitment, ctx.deployment,
    snapshot.mint, snapshot.wallet, proof.address, snapshot.read.slot, connected?.address,
  ])
  const { plan, planning, error } = preparation
  const execution = useExecutePlan()
  const walletLabel = labelFor(deployment, snapshot.wallet)
  const assetLabel = labelFor(deployment, snapshot.mint)

  const prepare = async () => {
    if (!execution.reset()) return
    await preparation.prepare(() => backend.planRenewBinding({ cluster: ctx.cluster, mint: snapshot.mint, wallet: snapshot.wallet, attestation: proof.address }))
  }

  return (
    <div className="box">
      <div className="actions" style={{ marginTop: 0 }}>
        <button type="button" onClick={() => void prepare()} disabled={planning}>
          {planning && <Spinner />} {t('detail.bindAction', { verifier: labelFor(deployment, proof.attestation.credential), asset: assetLabel })}
        </button>
        {connected?.address !== snapshot.wallet && <span className="small muted">{t('detail.bindNeedsWallet', { wallet: walletLabel })}</span>}
      </div>
      {error && <p className="small warn-text" role="alert">{t('operations.prepareFailed')}</p>}
      {plan && (
        <PlanReview
          plan={plan}
          signerLabel={walletLabel}
          signLabel={t('incidents.sign', { wallet: walletLabel })}
          execution={execution.state}
          onSign={() => {
            if (preparation.isCurrent(plan)) void execution.execute(plan)
          }}
        />
      )}
      {execution.state.evidence && <EvidenceView evidence={execution.state.evidence} decimals={execution.displayMetadata?.decimals} labelOf={(a) => labelFor(execution.displayMetadata?.deployment ?? deployment, a)} onRecheck={() => void execution.recheck()} rechecking={execution.state.phase === 'verifying'} contextMatches={execution.contextMatches} persistenceWarning={execution.journalError} />}
    </div>
  )
}
