import type { DeskPlan } from '../../api/backend'
import { ReasonList } from '../../components/reasons'
import { useI18n } from '../../i18n/context'

/** Resultado da simulação de um plano: aprovado ou motivo, unidades de computação e logs. */
export function SimulationSummary({ plan, title }: { plan: DeskPlan; title?: string }) {
  const { t, locale } = useI18n()
  return (
    <>
      <div className={`simulation ${plan.simulation.ok ? 'ok' : 'bad'}`}>
        <strong>
          {title && `${title}: `}
          {plan.blocked ? t('transfer.blocked') : plan.simulation.ok ? t('transfer.simulationOk') : t('transfer.simulationFail')}
        </strong>
        {plan.simulation.error && <ReasonList reasons={[plan.simulation.error]} showDetail />}
        {plan.simulation.unitsConsumed !== undefined && (
          <p className="small muted">{t('transfer.cu', { units: plan.simulation.unitsConsumed.toLocaleString(locale) })}</p>
        )}
      </div>
      {plan.simulation.logs.length > 0 && (
        <details>
          <summary>{t('transfer.logs')}</summary>
          <pre className="logs">{plan.simulation.logs.join('\n')}</pre>
        </details>
      )}
    </>
  )
}
