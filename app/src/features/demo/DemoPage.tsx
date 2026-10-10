import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { useReadyDesk } from '../../app/desk'
import { Badge, Card } from '../../components/ui'
import { useI18n } from '../../i18n/context'
import type { MessageKey } from '../../i18n/messages'
import { DEMO_SCENES, fetchDemoEvidence, verifyDemoTransactions } from './evidence'

const GUIDE: Record<string, { title: MessageKey; body: MessageKey; to: string; link: MessageKey }> = {
  reuse: { title: 'demo.reuse.title', body: 'demo.reuse.body', to: '/carteiras', link: 'nav.assets' },
  policies: { title: 'demo.policies.title', body: 'demo.policies.body', to: '/carteiras', link: 'nav.assets' },
  outside: { title: 'demo.outside.title', body: 'demo.outside.body', to: '/transferencia', link: 'nav.transfer' },
  invalidation: { title: 'demo.invalidation.title', body: 'demo.invalidation.body', to: '/recibos', link: 'nav.receipts' },
  impact: { title: 'demo.impact.title', body: 'demo.impact.body', to: '/incidentes', link: 'nav.incidents' },
  renewal: { title: 'demo.renewal.title', body: 'demo.renewal.body', to: '/incidentes', link: 'nav.incidents' },
}

export function DemoPage() {
  const desk = useReadyDesk()
  const { t, has } = useI18n()
  // Resolve the evidence beside the manifest without inheriting its query string.
  const manifest = new URL(desk.env.VITE_DEPLOYMENT_URL, window.location.href)
  const evidenceUrl = new URL('judge-evidence.json', manifest).href
  const local = desk.env.VITE_CLUSTER === 'localnet'
  const evidence = useQuery({
    queryKey: ['demo-evidence', desk.env.VITE_DEPLOYMENT_URL, desk.env.VITE_CLUSTER, desk.programId, desk.deployment.generatedAt],
    queryFn: ({ signal }) => fetchDemoEvidence(evidenceUrl, desk.deployment, signal),
    enabled: local,
    retry: false,
    refetchOnWindowFocus: false,
  })
  const bundle = evidence.data
  const evidencePending = evidence.isPending || evidence.isFetching || evidence.fetchStatus === 'paused'
  const verification = useQuery({
    queryKey: ['demo-ledger', desk.env.VITE_DEPLOYMENT_URL, desk.env.VITE_CLUSTER, desk.programId,
      desk.ctx.rpcUrl, desk.ctx.commitment, bundle?.genesisHash, bundle?.deploymentGeneratedAt, bundle?.completedAt, evidence.dataUpdatedAt],
    queryFn: ({ signal }) => {
      if (!local || !bundle || evidence.isError || evidencePending) throw new Error('Evidence unavailable')
      return verifyDemoTransactions(desk.ctx, bundle, signal)
    },
    enabled: false,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
  const verificationPending = verification.isFetching || verification.fetchStatus === 'paused'
  const results = !evidencePending && !evidence.isError && !verificationPending && !verification.isError
    ? verification.data : undefined
  const canCheck = local && !!bundle && !evidencePending && !evidence.isError && !verificationPending
  const signatures = bundle?.scenes.flatMap((scene) => scene.stages.flatMap((stage) =>
    stage.evidence.flatMap((entry) => typeof entry.signature === 'string' ? [entry.signature] : []))) ?? []
  // A rebind signature can also appear in its saved readback; count it only once.
  const counts = { verified: 0, unavailable: 0, mismatch: 0 }
  if (results) for (const signature of new Set(signatures)) {
    counts[results.find((result) => result.signature === signature)?.status ?? 'unavailable'] += 1
  }

  return (
    <div className="demo-page">
      <Card title={t('demo.problemTitle')}>
        <p>{t('demo.problem')}</p>
        <p className="small muted">{t('demo.scope')}</p>
      </Card>
      <Card>
        <p>{t('demo.history')}</p>
        {!local ? <p role="note">{t('demo.localOnly')}</p> : <>
          {evidencePending && <p role="status">{t('demo.loading')}</p>}
          {evidence.isError && <div role="alert"><p>{t('demo.failed')}</p>
            <p className="small">{t('demo.evidenceHelp')}</p>
            <button type="button" disabled={evidencePending} onClick={() => void evidence.refetch()}>{t('state.retry')}</button>
          </div>}
          {!evidencePending && !evidence.isError && (!bundle || bundle.scenes.length === 0) && <p role="status">{t('demo.empty')}</p>}
          <button type="button" disabled={!canCheck || signatures.length === 0} onClick={() => void verification.refetch()}>
            {t(verificationPending ? 'demo.rechecking' : 'demo.recheck')}
          </button>
          <p className="small muted">{t('demo.recheckNote')}</p>
          {verificationPending && <p role="status">{t('demo.rechecking')}</p>}
          {verification.isError && <p role="alert">{t('demo.recheckFailed')}</p>}
          {results && <div className="demo-ledger-summary">
            <p role="status">{t('demo.summary', counts)}</p>
            {counts.unavailable > 0 && <p>{t('demo.unavailableHelp')}</p>}
            {counts.mismatch > 0 && <p role="alert">{t('demo.mismatchHelp')}</p>}
          </div>}
        </>}
        <details className="demo-details">
          <summary>{t('demo.recordDetails')}</summary>
          <p className="small">{t('demo.readClaims')}</p>
          <p className="small">{t('demo.separate')}</p>
          {local && bundle && <dl>
            <dt>{t('config.program')}</dt><dd><code>{bundle.programId}</code></dd>
            <dt>{t('demo.genesis')}</dt><dd><code>{bundle.genesisHash}</code></dd>
            <dt>{t('demo.generated')}</dt><dd>{bundle.deploymentGeneratedAt}</dd>
            <dt>{t('demo.completed')}</dt><dd>{bundle.completedAt}</dd>
          </dl>}
        </details>
      </Card>
      <ol className="demo-scenes">
        {DEMO_SCENES.map((definition, index) => {
          const guide = GUIDE[definition.id]
          const scene = local ? bundle?.scenes.find((entry) => entry.id === definition.id) : undefined
          const sceneSignatures = scene?.stages.flatMap((stage) => stage.evidence.flatMap((entry) =>
            typeof entry.signature === 'string' ? [entry.signature] : [])) ?? []
          const checked = sceneSignatures.length > 0 && sceneSignatures.every((signature) =>
            results?.find((result) => result.signature === signature)?.status === 'verified')
          const mismatch = sceneSignatures.some((signature) => results?.some((result) => result.signature === signature && result.status === 'mismatch'))
          const unavailable = !!results && sceneSignatures.some((signature) => !results.some((result) => result.signature === signature) ||
            results.some((result) => result.signature === signature && result.status === 'unavailable'))
          return <li key={definition.id} className="card demo-scene">
            <div className="demo-scene-heading"><span className="demo-number" aria-hidden="true">{index + 1}</span>
              <h2>{t(guide.title)}</h2></div>
            <p>{t(guide.body)}</p>
            <Badge>{t(scene?.stages.length ? checked ? 'demo.checked' : 'demo.recorded' : 'demo.notRun')}</Badge>
            {mismatch && <p role="alert">{t('demo.mismatch')}</p>}
            {unavailable && <p role="status">{t('demo.unavailable')}</p>}
            <p><Link to={guide.to}>{t(guide.link)} →</Link></p>
            {!!scene?.stages.length && <details className="demo-details">
              <summary>{t('demo.details')}</summary>
              {scene.stages.map((stage) => <section key={stage.id} className="demo-stage">
                <h3>{t('demo.stage')}: <code>{stage.id}</code></h3>
                {stage.evidence.length === 0 && <p>{t('demo.empty')}</p>}
                {stage.evidence.map((entry, entryIndex) => {
                  const result = typeof entry.signature === 'string' ? results?.find((item) => item.signature === entry.signature) : undefined
                  const reasonKey = has(`reason.${entry.hookCode}.generic`) ? `reason.${entry.hookCode}.generic` : `reason.${entry.hookCode}`
                  return <div key={entryIndex} className="demo-observation">
                    {typeof entry.signature === 'string' ? <>
                      <p className="small">{t('evidence.signature')}: <code>{entry.signature}</code></p>
                      <Badge tone={result?.status === 'verified' ? 'ok' : result?.status === 'mismatch' ? 'bad' : 'neutral'}>
                        {t(result?.status === 'verified' ? 'demo.verified' : result?.status === 'mismatch' ? 'demo.mismatch' : results ? 'demo.unavailable' : 'demo.recorded')}
                      </Badge>
                    </> : <p className="small muted">{t('demo.observation')}</p>}
                    {entry.slot !== undefined && <p className="small">{t('demo.savedSlot', { slot: entry.slot })}</p>}
                    {result?.slot !== undefined && <p className="small">{t('demo.ledgerSlot', { slot: result.slot })}</p>}
                    {entry.hookCode && <p className="small">{t('demo.reason')}: {has(reasonKey) ? t(reasonKey) : t('demo.rejected')}</p>}
                    {(['sharedProof', 'proof', 'closedProof', 'renewal'] as const).map((key) => typeof entry[key] === 'string' &&
                      <p key={key} className="small">{t('demo.proof')}: <code>{entry[key]}</code></p>)}
                    {entry.wallet && <p className="small">{t('assets.wallet')}: <code>{entry.wallet}</code></p>}
                    {entry.asset && <p className="small">{t('transfer.asset')}: {entry.asset}</p>}
                    {entry.slots && <p className="small">{entry.slots.map((slot) => t('demo.savedSlot', { slot })).join(' · ')}</p>}
                    {entry.verdicts && <p className="small">{t('demo.observation')}: {entry.verdicts.map((verdict) => t(`verdict.${verdict}`)).join(' · ')}</p>}
                    {entry.before && entry.after && <div className="small"><p>{t('demo.observation')} · {t('evidence.balances')}</p>
                      <table><thead><tr><th>{t('demo.party')}</th><th>{t('evidence.before')}</th><th>{t('evidence.after')}</th></tr></thead>
                        <tbody>{(['source', 'destination'] as const).map((side, sideIndex) => <tr key={side}>
                          <th>{t(`side.${side}`)}</th><td>{entry.before![sideIndex]}</td><td>{entry.after![sideIndex]}</td>
                        </tr>)}</tbody></table>
                    </div>}
                    {(['mints', 'affectedMints'] as const).map((key) => Array.isArray(entry[key]) &&
                      <div key={key} className="small">{t('demo.mints')}<ul>{entry[key].map((mint) => <li key={mint}><code>{mint}</code></li>)}</ul></div>)}
                  </div>
                })}
              </section>)}
            </details>}
          </li>
        })}
      </ol>
    </div>
  )
}
