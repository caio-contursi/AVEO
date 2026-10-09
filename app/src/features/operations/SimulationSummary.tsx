import type { DeskPlan } from '../../api/backend'
import { ReasonList } from '../../components/reasons'
import { useI18n } from '../../i18n/context'

/** Show preflight decisions immediately and keep technical output available on demand. */
export function SimulationSummary({ plan, title }: { plan: DeskPlan; title?: string }) {
  const { t, locale } = useI18n()
  // Transfers use the hook; binding and policy use the program directly.
  const accepted = plan.request.kind === 'transfer' ? t('transfer.simulationOk') : t('plan.simulationOk')
  return (
    <>
      <div className={`simulation ${plan.simulation.ok && !plan.blocked ? 'ok' : 'bad'}`} role="status">
        <strong>
          {title && `${title}: `}
          {plan.blocked ? t('transfer.blocked') : plan.simulation.ok ? accepted : t('transfer.simulationFail')}
        </strong>
        {plan.simulation.error && <ReasonList reasons={[plan.simulation.error]} showDetail />}
        {plan.blocked && plan.blocked !== plan.simulation.error && <ReasonList reasons={[plan.blocked]} showDetail />}
      </div>
      {(plan.simulation.unitsConsumed !== undefined || plan.simulation.logs.length > 0) && (
        <details className="technical-details">
          <summary>{t('ux.technicalDetails')}</summary>
          {plan.simulation.unitsConsumed !== undefined && (
            <p className="small muted">{t('transfer.cu', { units: plan.simulation.unitsConsumed.toLocaleString(locale) })}</p>
          )}
          {plan.simulation.logs.length > 0 && (
            <>
              <h3>{t('transfer.logs')}</h3>
              <pre className="logs">{plan.simulation.logs.join('\n')}</pre>
            </>
          )}
        </details>
      )}
    </>
  )
}
