import { useState } from 'react'
import type { DeskSnapshot } from '../../api/diagnostics'
import { useReadyDesk } from '../../app/desk'
import { formatAmount } from '../../components/format'
import { describeReason } from '../../components/describeReason'
import { Card, ErrorState, LoadingState, VerdictBadge } from '../../components/ui'
import { useI18n } from '../../i18n/context'
import { labelFor } from '../operations/labels'
import { PolicyCard } from './PolicyCard'
import { ProofsTable } from './ProofsTable'
import { SnapshotDetail } from './SnapshotDetail'
import { useAssetsQuery, useHoldingsQuery, useInspectQueries } from './queries'

function Matrix() {
  const i18n = useI18n()
  const { t, locale } = i18n
  const { deployment } = useReadyDesk()
  const [selected, setSelected] = useState<{ mint: string; wallet: string } | null>(null)
  const holdings = useHoldingsQuery()
  const pairs = deployment.wallets.flatMap((w) => deployment.assets.map((a) => ({ mint: a.mint, wallet: w.address })))
  const results = useInspectQueries(pairs)
  const snapshotOf = (mint: string, wallet: string): DeskSnapshot | undefined =>
    results[pairs.findIndex((p) => p.mint === mint && p.wallet === wallet)]?.data
  const selectedSnapshot = selected ? snapshotOf(selected.mint, selected.wallet) : undefined

  return (
    <>
      <div className="table-wrap">
        <table className="matrix">
          <thead>
            <tr>
              <th>{t('assets.wallet')}</th>
              {deployment.assets.map((a) => (
                <th key={a.mint}>{a.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {deployment.wallets.map((w) => (
              <tr key={w.address}>
                <td>
                  <strong>{w.label}</strong>
                </td>
                {deployment.assets.map((a) => {
                  const index = pairs.findIndex((p) => p.mint === a.mint && p.wallet === w.address)
                  const query = results[index]
                  const snapshot = query?.data
                  const amount = holdings.data?.holdings.find((h) => h.mint === a.mint && h.wallet === w.address)?.amount
                  const isSelected = selected?.mint === a.mint && selected.wallet === w.address
                  const primary = snapshot?.reasons.find((r) => !r.hint)
                  return (
                    <td key={a.mint}>
                      <button type="button" className={`cell ${isSelected ? 'selected' : ''}`} onClick={() => setSelected({ mint: a.mint, wallet: w.address })}>
                        <span className="cell-top">
                          {snapshot ? <VerdictBadge verdict={snapshot.verdict} /> : query?.error ? <VerdictBadge verdict="unknown" /> : <span className="muted small">…</span>}
                          <span className="muted small">
                            {amount !== undefined ? `${formatAmount(locale, amount, a.decimals)} ${a.symbol}` : ''}
                          </span>
                        </span>
                        <span className="small muted">
                          {primary
                            ? describeReason(i18n, primary)
                            : snapshot?.proof
                              ? labelFor(deployment, snapshot.proof.credential)
                              : ''}
                        </span>
                      </button>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selectedSnapshot && <SnapshotDetail snapshot={selectedSnapshot} />}
    </>
  )
}

export function AssetsPage() {
  const { t } = useI18n()
  const assets = useAssetsQuery()
  return (
    <div className="stack">
      <Card title={t('assets.policies')} aside={<span className="muted small">{t('assets.policiesHint')}</span>}>
        {assets.isLoading && <LoadingState />}
        {assets.error && <ErrorState error={assets.error} onRetry={() => void assets.refetch()} />}
        {assets.data && (
          <div className="policy-grid">
            {assets.data.assets.map((state) => (
              <PolicyCard key={state.asset.mint} state={state} />
            ))}
          </div>
        )}
      </Card>
      <Card title={t('assets.proofs')} aside={<span className="muted small">{t('assets.proofsHint')}</span>}>
        <ProofsTable />
      </Card>
      <Card title={t('assets.matrix')} aside={<span className="muted small">{t('assets.matrixHint')}</span>}>
        <Matrix />
      </Card>
    </div>
  )
}
