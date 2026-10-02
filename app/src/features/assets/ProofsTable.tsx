import { useReadyDesk } from '../../app/desk'
import { Address } from '../../components/Address'
import { formatExpiry } from '../../components/format'
import { Badge, EmptyState, ErrorState, LoadingState } from '../../components/ui'
import { useI18n } from '../../i18n/context'
import { labelFor } from '../operations/labels'
import { useClockQuery, useProofsQuery } from './queries'

export function ProofsTable() {
  const { t } = useI18n()
  const { deployment } = useReadyDesk()
  const proofs = useProofsQuery()
  const clock = useClockQuery()

  if (proofs.isLoading) return <LoadingState />
  if (proofs.error) return <ErrorState error={proofs.error} onRetry={() => void proofs.refetch()} />
  if (!proofs.data || proofs.data.length === 0) return <EmptyState>{t('assets.noProofs')}</EmptyState>
  const now = clock.data?.unix ?? Math.floor(Date.now() / 1000)

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>{t('assets.wallet')}</th>
            <th>{t('assets.verifier')}</th>
            <th>{t('assets.facts')}</th>
            <th>{t('assets.validity')}</th>
            <th>{t('assets.usedBy')}</th>
            <th>{t('assets.account')}</th>
          </tr>
        </thead>
        <tbody>
          {proofs.data.map((p) => {
            const expired = p.attestation.expiry <= BigInt(now)
            return (
              <tr key={p.address} className={expired ? 'dim' : ''}>
                <td>{labelFor(deployment, p.wallet)}</td>
                <td>{labelFor(deployment, p.attestation.credential)}</td>
                <td>
                  {p.payload ? (
                    <>
                      <span className={`chip ${p.payload.kycPass ? '' : 'off'}`}>
                        {t('fact.kyc')} {p.payload.kycPass ? t('assets.yes') : t('assets.no')}
                      </span>
                      <span className={`chip ${p.payload.accreditedPass ? '' : 'off'}`}>
                        {t('fact.accredited')} {p.payload.accreditedPass ? t('assets.yes') : t('assets.no')}
                      </span>
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td className={expired ? 'bad-text' : ''}>{formatExpiry(t, p.attestation.expiry, now)}</td>
                <td>
                  {p.boundTo.length === 0 && <span className="muted small">{t('assets.notBound')}</span>}
                  {p.boundTo.map((mint) => (
                    <span key={mint} className="chip">
                      {deployment.assets.find((a) => a.mint === mint)?.symbol ?? mint}
                    </span>
                  ))}
                  {p.boundTo.length > 1 && <Badge tone="accent">{t('assets.shared')}</Badge>}
                </td>
                <td>
                  <Address value={p.address} short />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
