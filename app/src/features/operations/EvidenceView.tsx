import type { DeskEvidence } from '../../api/backend'
import { useDesk } from '../../app/desk'
import { Address } from '../../components/Address'
import { formatAmount, formatSlot } from '../../components/format'
import { ReasonList } from '../../components/reasons'
import { Badge, VerdictBadge } from '../../components/ui'
import { useI18n } from '../../i18n/context'

const TONE = { confirmed: 'ok', failed: 'bad', unknown: 'unknown' } as const

/** Evidência da operação: status da assinatura, readback das partes e logs. Sem link inventado. */
export function EvidenceView({ evidence, decimals = 0, labelOf }: { evidence: DeskEvidence; decimals?: number; labelOf: (address: string) => string }) {
  const { t, locale } = useI18n()
  const desk = useDesk()
  const explorer = evidence.signature ? desk.explorerUrl(evidence.signature) : null
  return (
    <div className="box">
      <div className="actions" style={{ marginTop: 0 }}>
        <Badge tone={TONE[evidence.status]}>{t(`evidence.${evidence.status}`)}</Badge>
        {evidence.slot !== undefined && <span className="small muted">{t('evidence.slot', { slot: formatSlot(locale, evidence.slot) })}</span>}
      </div>
      {evidence.signature && (
        <p className="small">
          {t('evidence.signature')}: <Address value={evidence.signature} short />{' '}
          {explorer ? (
            <a href={explorer} target="_blank" rel="noreferrer">
              {t('evidence.explorer')}
            </a>
          ) : (
            <span className="muted">({t('evidence.noExplorer')})</span>
          )}
        </p>
      )}
      {evidence.error && <ReasonList reasons={[evidence.error]} showDetail />}
      {evidence.balances && evidence.balances.length > 0 && (
        <>
          <h3>{t('evidence.balances')}</h3>
          <table>
            <thead>
              <tr>
                <th>{t('assets.wallet')}</th>
                <th>{t('evidence.before')}</th>
                <th>{t('evidence.after')}</th>
              </tr>
            </thead>
            <tbody>
              {evidence.balances.map((b) => (
                <tr key={b.owner}>
                  <td>{labelOf(b.owner)}</td>
                  <td>{b.before !== undefined ? formatAmount(locale, b.before, decimals) : '—'}</td>
                  <td>{formatAmount(locale, b.after, decimals)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {evidence.readback && evidence.readback.length > 0 && (
        <>
          <h3>{t('evidence.readback')}</h3>
          <ul className="timeline">
            {evidence.readback.map((snapshot) => (
              <li key={`${snapshot.mint}-${snapshot.wallet}`}>
                <span>
                  <VerdictBadge verdict={snapshot.verdict} /> {labelOf(snapshot.wallet)} · {labelOf(snapshot.mint)}
                </span>
                <ReasonList reasons={snapshot.reasons.filter((r) => !r.hint)} />
              </li>
            ))}
          </ul>
        </>
      )}
      {evidence.logs.length > 0 && (
        <details>
          <summary>{t('evidence.logs')}</summary>
          <pre className="logs">{evidence.logs.join('\n')}</pre>
        </details>
      )}
    </div>
  )
}
