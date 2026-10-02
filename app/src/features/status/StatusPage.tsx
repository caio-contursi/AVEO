import { useQuery } from '@tanstack/react-query'
import { readAssets, readNetworkStatus } from '../../api/inventory'
import { useDesk } from '../../app/desk'
import { RequireDeployment } from '../../app/RequireDeployment'
import { Address } from '../../components/Address'
import { formatAmount, formatSlot } from '../../components/format'
import { ReasonList } from '../../components/reasons'
import { Badge, Card, ErrorState, LoadingState } from '../../components/ui'
import { useI18n } from '../../i18n/context'

function NetworkCard() {
  const { t, locale } = useI18n()
  const desk = useDesk()
  const status = useQuery({ queryKey: ['network-status'], queryFn: () => readNetworkStatus(desk.rpcReader) })
  return (
    <Card title={t('status.network')}>
      {status.isLoading && <LoadingState />}
      {status.error && <ErrorState error={status.error} onRetry={() => void status.refetch()} />}
      {status.data && (
        <>
          <dl className="kv">
            <dt>{t('status.slot')}</dt>
            <dd>{formatSlot(locale, status.data.slot)}</dd>
            <dt>{t('status.version')}</dt>
            <dd>{status.data.version ?? '—'}</dd>
          </dl>
          <h3>{t('status.programs')}</h3>
          <div className="table-wrap">
            <table>
              <tbody>
                {status.data.programs.map((p) => (
                  <tr key={p.id}>
                    <td>{p.label}</td>
                    <td>
                      <Address value={p.id} />
                    </td>
                    <td>
                      {p.executable ? <Badge tone="ok">{t('status.deployed')}</Badge> : <Badge tone="bad">{t('status.notDeployed')}</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  )
}

function AssetsCard() {
  const { t, locale } = useI18n()
  const desk = useDesk()
  const assets = useQuery({ queryKey: ['assets'], queryFn: () => readAssets(desk.ctx!), enabled: !!desk.ctx })
  return (
    <Card title={t('status.assets')}>
      {assets.isLoading && <LoadingState />}
      {assets.error && <ErrorState error={assets.error} onRetry={() => void assets.refetch()} />}
      {assets.data && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('transfer.asset')}</th>
                <th>{t('status.mint')}</th>
                <th>{t('status.policy')}</th>
                <th>{t('status.extraMetas')}</th>
                <th>{t('status.supply')}</th>
                <th>{t('status.mintAuthority')}</th>
              </tr>
            </thead>
            <tbody>
              {assets.data.assets.map((row) => (
                <tr key={row.asset.mint}>
                  <td>
                    <strong>{row.asset.label}</strong> <span className="muted small">{row.asset.symbol}</span>
                  </td>
                  <td>
                    <Address value={row.asset.mint} short />{' '}
                    {row.mintExists ? <Badge tone="ok">{t('status.ok')}</Badge> : <Badge tone="bad">{t('status.missing')}</Badge>}
                  </td>
                  <td>
                    {row.policy ? (
                      <Badge tone="ok">{t('assets.version', { version: String(row.policy.policyVersion) })}</Badge>
                    ) : (
                      row.policyFailure && <ReasonList reasons={[row.policyFailure]} />
                    )}
                  </td>
                  <td>{row.extraMetasExists ? <Badge tone="ok">{t('status.ok')}</Badge> : <Badge tone="bad">{t('status.missing')}</Badge>}</td>
                  <td>{row.supply !== undefined ? formatAmount(locale, row.supply, row.asset.decimals) : '—'}</td>
                  <td>{row.mintAuthority === null ? <span className="muted">{t('status.removed')}</span> : row.mintAuthority ? <Address value={row.mintAuthority} short /> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

export function StatusPage() {
  const { t, locale } = useI18n()
  const desk = useDesk()
  return (
    <div className="stack">
      <Card title={t('config.title')}>
        <dl className="kv">
          <dt>{t('config.cluster')}</dt>
          <dd>{desk.env.VITE_CLUSTER}</dd>
          <dt>{t('config.rpc')}</dt>
          <dd>
            <code>{desk.env.VITE_RPC_URL}</code>
          </dd>
          <dt>{t('config.commitment')}</dt>
          <dd>{desk.commitment}</dd>
          <dt>{t('config.backend')}</dt>
          <dd>{desk.env.VITE_BACKEND}</dd>
          <dt>{t('config.program')}</dt>
          <dd>
            <Address value={desk.programId} />
          </dd>
          <dt>{t('config.manifest')}</dt>
          <dd>
            <code>{desk.env.VITE_DEPLOYMENT_URL}</code>
            {desk.deployment && (
              <span className="muted small"> · {t('config.generatedAt', { date: new Date(desk.deployment.generatedAt).toLocaleString(locale) })}</span>
            )}
          </dd>
        </dl>
      </Card>
      <NetworkCard />
      <RequireDeployment>
        <AssetsCard />
      </RequireDeployment>
    </div>
  )
}
