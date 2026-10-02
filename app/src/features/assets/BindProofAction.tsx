import { useState } from 'react'
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

/**
 * Vincula uma prova válida e aceita pela política (set_binding). A própria carteira assina:
 * o Desk só monta e simula (spec v3, seção 6.3).
 */
export function BindProofAction({ snapshot, proof }: { snapshot: DeskSnapshot; proof: ProofRow }) {
  const { t } = useI18n()
  const { backend, ctx, deployment } = useReadyDesk()
  const { connected } = useWallet()
  const [plan, setPlan] = useState<DeskPlan>()
  const [planning, setPlanning] = useState(false)
  const execution = useExecutePlan()
  const walletLabel = labelFor(deployment, snapshot.wallet)
  const assetLabel = labelFor(deployment, snapshot.mint)

  const prepare = async () => {
    setPlanning(true)
    execution.reset()
    try {
      setPlan(await backend.planRenewBinding({ cluster: ctx.cluster, mint: snapshot.mint, wallet: snapshot.wallet, attestation: proof.address }))
    } finally {
      setPlanning(false)
    }
  }

  return (
    <div className="box">
      <div className="actions" style={{ marginTop: 0 }}>
        <button type="button" onClick={() => void prepare()} disabled={planning}>
          {planning && <Spinner />} {t('detail.bindAction', { verifier: labelFor(deployment, proof.attestation.credential), asset: assetLabel })}
        </button>
        {connected?.address !== snapshot.wallet && <span className="small muted">{t('detail.bindNeedsWallet', { wallet: walletLabel })}</span>}
      </div>
      {plan && (
        <PlanReview
          plan={plan}
          signerLabel={walletLabel}
          signLabel={t('incidents.sign', { wallet: walletLabel })}
          execution={execution.state}
          onSign={() => void execution.execute(plan)}
        />
      )}
      {execution.state.evidence && <EvidenceView evidence={execution.state.evidence} labelOf={(a) => labelFor(deployment, a)} />}
    </div>
  )
}
