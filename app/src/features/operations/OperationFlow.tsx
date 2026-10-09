import { useI18n } from '../../i18n/context'
import { operationFlow, type OperationFlowInput } from './operation-flow'

const steps = ['ux.stepPrepare', 'ux.stepReview', 'ux.stepSign', 'ux.stepVerify'] as const
const statuses = {
  pending: 'ux.stagePending', current: 'ux.stageCurrent', complete: 'ux.stageComplete',
  blocked: 'ux.stageBlocked', unknown: 'ux.stageUnknown',
} as const

/** Progress reports observed facts; RPC confirmation does not assert party eligibility. */
export function OperationFlow(props: OperationFlowInput) {
  const { t } = useI18n()
  const flow = operationFlow(props)
  return (
    <section className="workflow" aria-label={t('ux.flowTitle')}>
      <div className="workflow-head">
        <h2>{t('ux.flowTitle')}</h2>
        <p className="small muted">{t('ux.flowNote')}</p>
      </div>
      <ol className="workflow-steps">
        {steps.map((step, index) => {
          const status = flow.stages[index]!
          return (
            <li key={step} className={`workflow-step ${status}`} data-status={status} aria-current={status === 'current' ? 'step' : undefined}>
              <span className="workflow-number" aria-hidden="true">{index + 1}</span>
              <span className="workflow-label">{t(step)}</span>
              <span className="workflow-status">{t(statuses[status])}</span>
            </li>
          )
        })}
      </ol>
      <p className="workflow-summary" role="status" aria-live="polite">{t(flow.summary)}</p>
    </section>
  )
}
