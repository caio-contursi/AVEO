import type { DeskPlan } from '../../api/backend'
import { ReasonList } from '../../components/reasons'
import { Spinner } from '../../components/ui'
import { useI18n } from '../../i18n/context'
import { useWallet } from '../../wallet/context'
import { SimulationSummary } from './SimulationSummary'
import type { ExecutionState } from './useExecutePlan'

/** Keep preflight visible and allow signing only by the required wallet. */
export function PlanReview({
  plan,
  signerLabel,
  signLabel,
  execution,
  onSign,
}: {
  plan: DeskPlan
  signerLabel: string
  signLabel: string
  execution: ExecutionState
  onSign: () => void
}) {
  const { t } = useI18n()
  const { connected } = useWallet()
  const required = plan.requiredSigners[0]
  const isSigner = connected?.address === required
  const busy = execution.phase === 'signing' || execution.phase === 'verifying'
  const sent = execution.phase === 'done' || !!execution.signature || execution.sendBlocked === true

  return (
    <div className="box decision-panel">
      <SimulationSummary plan={plan} />
      <div className="actions decision-actions">
        <button type="button" className="primary" disabled={!!plan.blocked || !plan.simulation.ok || !isSigner || busy || sent} onClick={onSign}>
          {busy && <Spinner />} {signLabel}
        </button>
        <span className="small muted quiet-note">{t('wallet.required', { wallet: signerLabel })}</span>
        {connected && !isSigner && <span className="small warn-text">{t('wallet.wrong', { wallet: signerLabel })}</span>}
      </div>
      {execution.phase === 'error' && execution.error && <ReasonList reasons={[execution.error]} showDetail />}
    </div>
  )
}
