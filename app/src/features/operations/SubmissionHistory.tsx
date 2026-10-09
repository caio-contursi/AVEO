import type { Signature } from '@solana/kit'
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ApiContext } from '../../api/context'
import { confirmSignature, type Confirmation } from '../../api/transactions'
import { useDesk } from '../../app/desk'
import { Address } from '../../components/Address'
import { Badge, Card, EmptyState, Spinner } from '../../components/ui'
import { useI18n } from '../../i18n/context'
import { getSubmissionJournal, type SubmissionJournal, type SubmissionReceipt } from './submission-journal'
import { copyPublicReceipt, exportPublicReceipt, type ReceiptCopyResult } from './receipt-export'

type ReceiptResult = { matches: boolean; confirmation?: Confirmation }

/** Only read confirmation after matching the receipt's original scope. */
// eslint-disable-next-line react-refresh/only-export-components -- Exported for isolated read-only safety tests.
export async function confirmReceipt(
  ctx: ApiContext, receipt: SubmissionReceipt, journal: Pick<SubmissionJournal, 'matches'>,
  isCurrent: () => boolean = () => true,
): Promise<ReceiptResult | undefined> {
  const matches = await journal.matches(ctx, receipt)
  if (!isCurrent()) return undefined
  if (!matches) return { matches: false }
  let confirmation: Confirmation
  try {
    confirmation = await confirmSignature(ctx, receipt.signature as Signature)
  } catch {
    confirmation = { status: 'unknown', logs: [] }
  }
  return isCurrent() ? { matches: true, confirmation } : undefined
}

/** Present stored metadata separately from fresh, session-only confirmation. */
export function SubmissionReceiptView({ receipt, result, busy, disabled, onRecheck }: {
  receipt: SubmissionReceipt; result?: ReceiptResult; busy: boolean; disabled: boolean; onRecheck: () => void
}) {
  const { t } = useI18n()
  const desk = useDesk()
  const [exportStatus, setExportStatus] = useState<ReceiptCopyResult['status'] | 'manualExport' | 'copying'>()
  const [exportText, setExportText] = useState<string>()
  const active = useRef(false)
  const copying = useRef(false)
  useEffect(() => {
    active.current = true
    return () => { active.current = false }
  }, [])

  async function copyReceipt() {
    if (copying.current || !active.current) return
    copying.current = true
    setExportStatus('copying')
    setExportText(undefined)
    try {
      const result = await copyPublicReceipt(receipt, () => active.current)
      if (result && active.current) {
        setExportStatus(result.status)
        if (result.status === 'copyFailed') setExportText(result.text)
      }
    } finally {
      copying.current = false
    }
  }

  function showExport() {
    const text = exportPublicReceipt(receipt)
    setExportText(text)
    setExportStatus(text === undefined ? 'invalidExport' : 'manualExport')
  }

  const explorer = result?.matches === true ? desk.explorerUrl(receipt.signature) : null
  const status = result?.matches === true ? result.confirmation?.status ?? 'unknown' : 'unknown'
  return (
    <div className="box">
      <Badge tone={status === 'confirmed' ? 'ok' : status === 'failed' ? 'bad' : 'unknown'}>{t(`evidence.${status}`)}</Badge>
      <p className="small">{t('evidence.signature')}: <Address value={receipt.signature} short />{' '}
        {explorer && <a href={explorer} target="_blank" rel="noreferrer">{t('evidence.explorer')}</a>}
        {result?.matches === true && receipt.cluster === 'localnet' && <span className="muted">{t('evidence.noExplorer')}</span>}
      </p>
      <dl className="small mono-wrap">
        <dt>{t('receipts.submittedAt')}</dt><dd>{receipt.submittedAt}</dd>
        <dt>{t('config.cluster')}</dt><dd>{receipt.cluster}</dd>
        <dt>{t('config.program')}</dt><dd>{receipt.programId}</dd>
        <dt>{t('config.commitment')}</dt><dd>{receipt.commitment}</dd>
        <dt>{t('receipts.deployment')}</dt><dd>{receipt.deploymentGeneratedAt}</dd>
      </dl>
      {result?.matches === false && <p className="warn-text" role="status">{t('evidence.contextChanged')}</p>}
      {result?.matches === true && result.confirmation?.slot !== undefined && <p className="small">{t('evidence.slot', { slot: result.confirmation.slot })}</p>}
      <button type="button" disabled={disabled || result?.matches !== true} onClick={onRecheck}>
        {busy && <Spinner />} {t(busy ? 'evidence.rechecking' : 'evidence.recheck')}
      </button>
      <p className="small muted">{t('receipts.exportNote')}</p>
      <button type="button" disabled={exportStatus === 'copying'} onClick={() => { void copyReceipt() }}>
        {t('receipts.copyReceipt')}
      </button>{' '}
      <button type="button" disabled={exportStatus === 'copying'} onClick={showExport}>{t('receipts.exportReceipt')}</button>
      <p className="small" role="status" aria-live="polite" aria-atomic="true">
        {exportStatus && t(`receipts.${exportStatus}`)}
      </p>
      {exportText !== undefined && <textarea aria-label={t('receipts.manualText')} readOnly rows={16}
        value={exportText} onFocus={(event) => { event.currentTarget.select() }} />}
    </div>
  )
}

function ScopedHistory({ ctx }: { ctx: ApiContext }) {
  const { t } = useI18n()
  const journal = getSubmissionJournal()
  const receipts = useSyncExternalStore(journal.subscribe, journal.getSnapshot, journal.getSnapshot)
  const [results, setResults] = useState<Record<string, ReceiptResult>>({})
  const [checking, setChecking] = useState<string>()
  const busy = useRef(false)
  const active = useRef(false)

  useLayoutEffect(() => {
    active.current = true
    return () => { active.current = false }
  }, [])

  useLayoutEffect(() => {
    let current = true
    void Promise.all(receipts.map(async (receipt) => {
      const matches = await journal.matches(ctx, receipt)
      if (current) setResults((previous) => ({
        ...previous, [receipt.signature]: { matches, confirmation: matches ? previous[receipt.signature]?.confirmation : undefined },
      }))
    })).catch(() => {
      if (current) setResults({})
    })
    return () => { current = false }
  }, [ctx, journal, receipts])

  async function recheck(receipt: SubmissionReceipt) {
    if (busy.current || !active.current) return
    busy.current = true
    setChecking(receipt.signature)
    try {
      const result = await confirmReceipt(ctx, receipt, journal, () => active.current)
      if (result) setResults((previous) => ({ ...previous, [receipt.signature]: result }))
    } catch {
      if (active.current) setResults((previous) => ({ ...previous, [receipt.signature]: { matches: false } }))
    } finally {
      busy.current = false
      if (active.current) setChecking(undefined)
    }
  }

  return (
    <Card title={t('receipts.title')}>
      <p className="small muted">{t('receipts.note')}</p>
      <p className="small muted">{t('receipts.scopeNote')}</p>
      {journal.error && <p className="warn-text" role="alert">{t(`receipts.${journal.error}`)}</p>}
      {receipts.length === 0 && <EmptyState>{t('receipts.empty')}</EmptyState>}
      {receipts.map((receipt) => <SubmissionReceiptView key={receipt.signature} receipt={receipt}
        result={results[receipt.signature]} busy={checking === receipt.signature} disabled={checking !== undefined}
        onRecheck={() => { void recheck(receipt) }} />)}
    </Card>
  )
}

export function SubmissionHistory() {
  const { ctx } = useDesk()
  if (!ctx) return null
  // A scope change remounts the session and discards every old confirmation reply.
  const scope = JSON.stringify([ctx.cluster, ctx.rpcUrl, ctx.programId, ctx.commitment, ctx.deployment])
  return <ScopedHistory key={scope} ctx={ctx} />
}
