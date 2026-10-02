import type { DiagnosticReason } from '../api/diagnostics'
import { useI18n } from '../i18n/context'
import { describeReason } from './describeReason'

/** Lista de motivos com o código estável visível (o mesmo do programa e dos testes). */
export function ReasonList({ reasons, showDetail = false }: { reasons: DiagnosticReason[]; showDetail?: boolean }) {
  const i18n = useI18n()
  if (reasons.length === 0) return null
  return (
    <ul className="reasons">
      {reasons.map((r, i) => (
        <li key={`${r.code}-${i}`} className={r.hint ? 'hint' : ''}>
          <code className="code">{r.code}</code>
          {r.side && <span className="tag">{i18n.t(r.side === 'source' ? 'side.source' : 'side.destination')}</span>}
          {r.hint && <span className="tag">{i18n.t('reason.hint')}</span>}
          <span>{describeReason(i18n, r)}</span>
          {showDetail && (r.code === 'SimulationFailed' || r.code === 'MissingExtraAccounts' || r.code === 'ReadUnverifiable') && r.message && (
            <span className="small muted mono-wrap">{r.message}</span>
          )}
        </li>
      ))}
    </ul>
  )
}
