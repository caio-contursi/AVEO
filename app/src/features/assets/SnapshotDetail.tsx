import type { DeskSnapshot } from '../../api/diagnostics'
import { useReadyDesk } from '../../app/desk'
import { Address } from '../../components/Address'
import { formatClock, formatExpiry, formatSlot } from '../../components/format'
import { ReasonList } from '../../components/reasons'
import { VerdictBadge } from '../../components/ui'
import { useI18n } from '../../i18n/context'
import { labelFor } from '../operations/labels'
import { BindProofAction } from './BindProofAction'
import { useAssetsQuery, useProofsQuery } from './queries'

/** Prova que a carteira poderia vincular neste ativo: válida, aceita pela política e diferente da atual. */
function useBindableProof(snapshot: DeskSnapshot) {
  const assets = useAssetsQuery()
  const proofs = useProofsQuery()
  if (snapshot.verdict !== 'ineligible') return undefined
  const policy = assets.data?.assets.find((a) => a.asset.mint === snapshot.mint)?.policy
  if (!policy || snapshot.clockUnix === undefined) return undefined
  return proofs.data?.find(
    (p) =>
      p.wallet === snapshot.wallet &&
      p.address !== snapshot.sourceAccounts.attestation &&
      p.attestation.expiry > BigInt(snapshot.clockUnix!) &&
      policy.pairs.some((pair) => pair.credential === p.attestation.credential && pair.schema === p.attestation.schema) &&
      (!policy.requireKyc || p.payload?.kycPass) &&
      (!policy.requireAccredited || p.payload?.accreditedPass),
  )
}

export function SnapshotDetail({ snapshot }: { snapshot: DeskSnapshot }) {
  const { t, locale } = useI18n()
  const { deployment } = useReadyDesk()
  const bindable = useBindableProof(snapshot)
  const accounts = Object.entries(snapshot.sourceAccounts).filter(([, value]) => value) as [string, string][]

  return (
    <div className="detail">
      <header>
        <strong>{t('detail.title', { wallet: labelFor(deployment, snapshot.wallet), asset: labelFor(deployment, snapshot.mint) })}</strong>
        <VerdictBadge verdict={snapshot.verdict} />
      </header>
      <p className="small muted">
        {t('detail.read', {
          slot: formatSlot(locale, snapshot.read.slot),
          commitment: snapshot.read.commitment,
          clock: snapshot.clockUnix !== undefined ? formatClock(locale, snapshot.clockUnix) : '—',
        })}
        {snapshot.policyVersion !== undefined && ` · ${t('assets.version', { version: String(snapshot.policyVersion) })}`}
      </p>
      <div className="grid-2">
        <div>
          <h3>{t('detail.proof')}</h3>
          {snapshot.proof ? (
            <p>
              {labelFor(deployment, snapshot.proof.credential)}
              {snapshot.clockUnix !== undefined && <span className="muted"> · {formatExpiry(t, snapshot.proof.expiry, snapshot.clockUnix)}</span>}
              <br />
              <Address value={snapshot.proof.attestation} short />
            </p>
          ) : (
            <p className="muted">{t('detail.noProof')}</p>
          )}
          <h3>{t('detail.reasons')}</h3>
          {snapshot.reasons.length === 0 ? <p className="ok-text">{t('detail.allGood')}</p> : <ReasonList reasons={snapshot.reasons} showDetail />}
          {bindable && <BindProofAction snapshot={snapshot} proof={bindable} />}
        </div>
        <div>
          <h3>{t('detail.accounts')}</h3>
          <dl className="kv">
            {accounts.map(([kind, value]) => (
              <div key={kind} style={{ display: 'contents' }}>
                <dt>{kind}</dt>
                <dd>
                  <Address value={value} short />
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </div>
  )
}
