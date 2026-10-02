import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useReadyDesk } from '../../app/desk'
import { formatSlot } from '../../components/format'
import { Badge, Card, EmptyState, ErrorState, Spinner } from '../../components/ui'
import { useI18n } from '../../i18n/context'
import { IncidentCard } from './IncidentCard'
import { applyScan } from './model'
import { useIncidentStore } from './store'

type Filter = 'open' | 'resolved' | 'all'

export function IncidentsPage() {
  const { t, locale } = useI18n()
  const { backend, ctx, deployment } = useReadyDesk()
  const queryClient = useQueryClient()
  const { data, update } = useIncidentStore()
  const [filter, setFilter] = useState<Filter>('open')
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<unknown>()
  const [lastPairs, setLastPairs] = useState<number>()

  // scan:once: lê os dois mints e as carteiras da demo uma vez, quando o operador pede (sem vigia 24/7).
  const scan = async () => {
    setScanning(true)
    setScanError(undefined)
    try {
      const pairs = deployment.assets.flatMap((a) => deployment.wallets.map((w) => ({ mint: a.mint, wallet: w.address })))
      const snapshots = await Promise.all(pairs.map((p) => backend.inspect({ cluster: ctx.cluster, ...p })))
      if (snapshots.every((s) => s.verdict === 'unknown')) throw new Error(snapshots[0]?.reasons[0]?.message ?? 'unreadable')
      const slot = Math.max(...snapshots.map((s) => s.read.slot))
      update((d) => applyScan(d, snapshots, slot, new Date().toISOString()))
      setLastPairs(pairs.length)
      await queryClient.invalidateQueries()
    } catch (error) {
      setScanError(error)
    } finally {
      setScanning(false)
    }
  }

  const open = data.incidents.filter((i) => i.state !== 'resolved')
  const resolved = data.incidents.filter((i) => i.state === 'resolved')
  const list = (filter === 'open' ? open : filter === 'resolved' ? resolved : data.incidents)
    .slice()
    .sort((a, b) => b.detectedSlot - a.detectedSlot)
  const filters: { id: Filter; label: string }[] = [
    { id: 'open', label: t('incidents.open', { n: open.length }) },
    { id: 'resolved', label: t('incidents.resolved', { n: resolved.length }) },
    { id: 'all', label: t('incidents.all', { n: data.incidents.length }) },
  ]

  return (
    <div className="stack">
      <Card
        title={t('incidents.title')}
        aside={
          <button type="button" className="primary" disabled={scanning} onClick={() => void scan()}>
            {scanning && <Spinner />} {scanning ? t('incidents.scanning') : t('incidents.scan')}
          </button>
        }
      >
        <p className="small">
          {data.lastScan
            ? `${t('incidents.lastScan', { slot: formatSlot(locale, data.lastScan.slot) })} · ${new Date(data.lastScan.at).toLocaleString(locale)}`
            : t('incidents.neverScanned')}
        </p>
        {lastPairs !== undefined && data.lastScan && (
          <p className="small muted">{t('incidents.scanSummary', { pairs: lastPairs, slot: formatSlot(locale, data.lastScan.slot) })}</p>
        )}
        <p className="small muted">{t('incidents.routeB')}</p>
        <p className="small">
          <Badge tone="warn">{t('incidents.mock')}</Badge> {t('incidents.mockStore')}
        </p>
        {scanError !== undefined && <ErrorState title={t('incidents.scanFailed')} error={scanError} onRetry={() => void scan()} />}
        <div className="filters" role="group">
          {filters.map((f) => (
            <button key={f.id} type="button" className={filter === f.id ? 'active' : ''} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
      </Card>

      {list.length === 0 ? <EmptyState>{t('incidents.empty')}</EmptyState> : list.map((incident) => <IncidentCard key={incident.id} incident={incident} />)}
    </div>
  )
}
