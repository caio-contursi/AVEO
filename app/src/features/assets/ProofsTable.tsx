import { policyRejection } from '../../api/eligibility'
import { useReadyDesk } from '../../app/desk'
import { Address } from '../../components/Address'
import { describeReason } from '../../components/describeReason'
import { formatExpiry } from '../../components/format'
import { Badge, EmptyState, ErrorState, LoadingState } from '../../components/ui'
import { useI18n } from '../../i18n/context'
import { labelFor } from '../operations/labels'
import { useAssetsQuery, useClockQuery, useProofsQuery } from './queries'

export function ProofsTable() {
  const i18n = useI18n()
  const { t } = i18n
  const { deployment } = useReadyDesk()
  const proofs = useProofsQuery()
  const assets = useAssetsQuery()
  const clock = useClockQuery()

  if (proofs.isLoading) return <LoadingState />
  if (proofs.error) return <ErrorState error={proofs.error} onRetry={() => void proofs.refetch()} />
  if (!proofs.data || proofs.data.length === 0) return <EmptyState>{t('assets.noProofs')}</EmptyState>
  const now = clock.data?.unix ?? Math.floor(Date.now() / 1000)

  return (
    <div className="table-wrap">
      <table className="stack-sm">
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
            // Um vínculo não garante aceitação: a política de cada ativo decide (o hook confere de novo).
            const bindings = p.boundTo.map((mint) => {
              const state = assets.data?.assets.find((a) => a.asset.mint === mint)
              return {
                mint,
                symbol: state?.asset.symbol ?? mint,
                label: state?.asset.label ?? mint,
                rejection: state?.policy ? policyRejection(state.policy, p.wallet, p.attestation) : undefined,
              }
            })
            const accepted = bindings.filter((b) => !b.rejection)
            return (
              <tr key={p.address} className={expired ? 'dim' : ''}>
                <td data-label={t('assets.wallet')}>
                  <div className="td-value">{labelFor(deployment, p.wallet)}</div>
                </td>
                <td data-label={t('assets.verifier')}>
                  <div className="td-value">{labelFor(deployment, p.attestation.credential)}</div>
                </td>
                <td data-label={t('assets.facts')}>
                  <div className="td-value">
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
                  </div>
                </td>
                <td data-label={t('assets.validity')} className={expired ? 'bad-text' : ''}>
                  <div className="td-value">{formatExpiry(t, p.attestation.expiry, now)}</div>
                </td>
                <td data-label={t('assets.usedBy')}>
                  <div className="td-value">
                    {p.boundTo.length === 0 && <span className="muted small">{t('assets.notBound')}</span>}
                    {bindings.map((b) =>
                      b.rejection ? (
                        <span
                          key={b.mint}
                          className="chip off"
                          title={describeReason(i18n, {
                            ...b.rejection,
                            params: { asset: b.label, verifier: labelFor(deployment, p.attestation.credential), ...b.rejection.params },
                          })}
                        >
                          {t('assets.boundNotAccepted', { asset: b.symbol })}
                        </span>
                      ) : (
                        <span key={b.mint} className="chip">
                          {b.symbol}
                        </span>
                      ),
                    )}
                    {accepted.length > 1 && <Badge tone="accent">{t('assets.shared')}</Badge>}
                  </div>
                </td>
                <td data-label={t('assets.account')}>
                  <div className="td-value">
                    <Address value={p.address} short />
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
