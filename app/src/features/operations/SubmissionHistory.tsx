import type { Signature } from '@solana/kit'
import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ApiContext } from '../../api/context'
import { confirmSignature, type Confirmation } from '../../api/transactions'
import { useDesk } from '../../app/desk'
import { Address } from '../../components/Address'
import { Badge, Card, EmptyState, Spinner } from '../../components/ui'
import { useI18n } from '../../i18n/context'
import { getSubmissionJournal, type SubmissionJournal, type SubmissionReceipt } from './submission-journal'
import { copyPublicReceipt, copyPublicReceiptHistory, exportPublicReceipt, exportPublicReceiptHistory, inspectPublicReceiptHistory, type ReceiptCopyResult } from './receipt-export'
import { receiptCapacity } from './receipt-capacity'
import { MAX_RECEIPTS, MAX_RECEIPT_BYTES } from './receipt-limits'

const receiptLimitParams = { maxCount: MAX_RECEIPTS, maxBytes: MAX_RECEIPT_BYTES }

type HistoryExportState = { status: ReceiptCopyResult['status'] | 'manualExport' | 'copying'; text?: string }

export function SubmissionHistoryCapacity({ receipts, error }: {
  receipts: unknown; error?: SubmissionJournal['error']
}) {
  const { t } = useI18n()
  const capacity = error === 'invalid-records' ? undefined : receiptCapacity(receipts)
  return <div className="box" role="status" aria-live="polite" aria-atomic="true">
    <p className="small muted">{t('receipts.capacityNote', receiptLimitParams)}</p>
    {!capacity
      ? <p className="warn-text">{t('receipts.capacityUnavailable')}</p>
      : <>
        <p className="small">{t('receipts.capacityCounter', { ...receiptLimitParams, count: capacity.count, bytes: capacity.bytes })}</p>
        {capacity.full ? <p className="warn-text">{t('receipts.capacityFull')}</p>
          : capacity.nearFull && <p className="warn-text">{t('receipts.capacityNearFull')}</p>}
      </>}
    {error === 'storage-unavailable' && <p className="warn-text">{t('receipts.capacityVolatile')}</p>}
  </div>
}

/** Explicit requests only; invalidate replies when their visible snapshot or session changes. */
// eslint-disable-next-line react-refresh/only-export-components -- Exported for isolated clipboard lifecycle tests.
export function createHistoryExport(onChange: (state: HistoryExportState) => void) {
  let generation = 0
  let copying = false
  function invalidate() { generation += 1; copying = false }
  return {
    invalidate,
    async copy(receipts: readonly SubmissionReceipt[], isCurrent: () => boolean) {
      if (copying || receipts.length === 0 || !isCurrent()) return
      copying = true
      const started = ++generation
      const current = () => generation === started && isCurrent()
      const snapshot = receipts.map((receipt) => ({ ...receipt }))
      onChange({ status: 'copying' })
      try {
        const result = await copyPublicReceiptHistory(snapshot, current)
        if (result && current()) onChange(result)
      } finally {
        if (generation === started) copying = false
      }
    },
    manual(receipts: readonly SubmissionReceipt[], isCurrent: () => boolean) {
      if (receipts.length === 0 || !isCurrent()) return
      // Manual export stays available and supersedes an outstanding clipboard request.
      invalidate()
      const text = exportPublicReceiptHistory(receipts)
      onChange(text === undefined ? { status: 'invalidExport' } : { status: 'manualExport', text })
    },
  }
}

export function SubmissionHistoryExport({ receipts, getSnapshot }: {
  receipts: readonly SubmissionReceipt[]; getSnapshot: () => readonly SubmissionReceipt[]
}) {
  const { t } = useI18n()
  const [state, setState] = useState<HistoryExportState>()
  const [exporter] = useState(() => createHistoryExport(setState))
  const active = useRef(false)
  useLayoutEffect(() => {
    active.current = true
    exporter.invalidate()
    setState(undefined)
    return () => { active.current = false; exporter.invalidate() }
  }, [exporter, receipts])
  // Check the store directly as well: a publish can precede React's next commit.
  const isCurrent = () => active.current && getSnapshot() === receipts
  const preview = inspectPublicReceiptHistory(receipts)
  const exportable = receipts.length > 0 && preview.status === 'ready'
  return <div className="box">
    <p className="small muted">{t('receipts.historyExportNote')}</p>
    <div role="status" aria-live="polite" aria-atomic="true">
      <p className="small muted">{t('receipts.historyPreviewNote')}</p>
      {preview.status === 'invalid'
        ? <p className="small warn-text">{t('receipts.historyPreviewInvalid')}</p>
        : <>
          <p className="small">{t('receipts.historyPreviewCounter', { bytes: preview.bytes, maxBytes: preview.maxBytes })}</p>
          {preview.status === 'tooLarge' && <p className="small warn-text">{t('receipts.historyPreviewTooLarge')}</p>}
        </>}
    </div>
    <button type="button" disabled={!exportable || state?.status === 'copying'}
      onClick={() => { void exporter.copy(receipts, isCurrent) }}>{t('receipts.copyHistory')}</button>{' '}
    <button type="button" disabled={!exportable}
      onClick={() => { exporter.manual(receipts, isCurrent) }}>{t('receipts.exportHistory')}</button>
    <p className="small" role="status" aria-live="polite" aria-atomic="true">
      {state && t(state.status === 'copying' ? 'receipts.historyCopying'
        : state.status === 'copied' ? 'receipts.historyCopied'
          : state.status === 'invalidExport' ? 'receipts.historyInvalidExport' : `receipts.${state.status}`)}
    </p>
    {state?.text !== undefined && <textarea aria-label={t('receipts.historyManualText')} readOnly rows={16}
      value={state.text} onFocus={(event) => { event.currentTarget.select() }} />}
  </div>
}

type ReceiptResult = { matches: boolean; confirmation?: Confirmation }
type RemovalState = 'idle' | 'confirming' | 'removing' | 'removeFailed' | 'removed'
type RemoveReceipt = (receipt: SubmissionReceipt) => Promise<void>

/** Explicit local intent only; no network or wallet access. */
// eslint-disable-next-line react-refresh/only-export-components -- Exported for isolated removal safety tests.
export function createReceiptRemoval(onChange: (state: RemovalState) => void) {
  let state: RemovalState = 'idle'
  function update(next: RemovalState) { state = next; onChange(next) }
  return {
    request(blocked = false) {
      if (!blocked && state === 'idle') update('confirming')
    },
    cancel() {
      if (state === 'confirming' || state === 'removeFailed') update('idle')
    },
    async confirm(receipt: SubmissionReceipt, onRemove: RemoveReceipt | undefined, isCurrent: () => boolean, blocked = false) {
      if (blocked || !onRemove || !isCurrent() || (state !== 'confirming' && state !== 'removeFailed')) return
      // Change synchronously so a second click cannot invoke removal again.
      update('removing')
      try {
        await onRemove(receipt)
        if (isCurrent()) update('removed')
      } catch {
        if (isCurrent()) update('removeFailed')
      }
    },
  }
}

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
type ReceiptViewProps = {
  receipt: SubmissionReceipt; result?: ReceiptResult; busy: boolean; disabled: boolean; onRecheck: () => void
  onRemove?: RemoveReceipt; matching?: boolean
}

export function SubmissionReceiptView(props: ReceiptViewProps) {
  // A different receipt gets its own confirmation, copy state and async guards.
  return <ReceiptView key={props.receipt.signature} {...props} />
}

function ReceiptView({ receipt, result, busy, disabled, onRecheck, onRemove, matching = false }: ReceiptViewProps) {
  const { t } = useI18n()
  const desk = useDesk()
  const [exportStatus, setExportStatus] = useState<ReceiptCopyResult['status'] | 'manualExport' | 'copying'>()
  const [exportText, setExportText] = useState<string>()
  const [removalState, setRemovalState] = useState<RemovalState>('idle')
  const [removal] = useState(() => createReceiptRemoval(setRemovalState))
  const warningId = useId()
  const active = useRef(false)
  const generation = useRef(0)
  const copying = useRef(false)
  useLayoutEffect(() => {
    active.current = true
    generation.current += 1
    return () => { active.current = false; generation.current += 1 }
  }, [])

  async function copyReceipt() {
    if (copying.current || !active.current) return
    copying.current = true
    const started = generation.current
    const isCurrent = () => active.current && generation.current === started
    setExportStatus('copying')
    setExportText(undefined)
    try {
      const result = await copyPublicReceipt(receipt, isCurrent)
      if (result && isCurrent()) {
        setExportStatus(result.status)
        if (result.status === 'copyFailed') setExportText(result.text)
      }
    } finally {
      if (isCurrent()) copying.current = false
    }
  }

  function showExport() {
    const text = exportPublicReceipt(receipt)
    setExportText(text)
    setExportStatus(text === undefined ? 'invalidExport' : 'manualExport')
  }

  const explorer = result?.matches === true ? desk.explorerUrl(receipt.signature) : null
  const status = result?.matches === true ? result.confirmation?.status ?? 'unknown' : 'unknown'
  const removing = removalState === 'removing'
  const removalBlocked = !onRemove || busy || matching || removing
  const warningVisible = removalState === 'confirming' || removing || removalState === 'removeFailed'

  function confirmRemoval() {
    const started = generation.current
    void removal.confirm(receipt, onRemove, () => active.current && generation.current === started, removalBlocked)
  }
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
      <button type="button" disabled={disabled || removing || result?.matches !== true} onClick={onRecheck}>
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
      {removalState === 'idle' && <button type="button" disabled={removalBlocked}
        onClick={() => { removal.request(removalBlocked) }}>{t('receipts.removeLocal')}</button>}
      {warningVisible && <div role="group" aria-labelledby={warningId} aria-busy={removing}>
        <p id={warningId} className="warn-text" role="alert">{t('receipts.removeWarning')}</p>
        <button type="button" disabled={removalBlocked} onClick={confirmRemoval}>{t('receipts.confirmRemove')}</button>{' '}
        <button type="button" disabled={removing} onClick={() => { removal.cancel() }}>{t('receipts.cancelRemove')}</button>
      </div>}
      <p className="small" role="status" aria-live="polite" aria-atomic="true">
        {(removing || removalState === 'removeFailed' || removalState === 'removed') && t(`receipts.${removalState}`)}
      </p>
    </div>
  )
}

function ScopedHistory({ ctx }: { ctx: ApiContext | null }) {
  const { t } = useI18n()
  const journal = getSubmissionJournal()
  const receipts = useSyncExternalStore(journal.subscribe, journal.getSnapshot, journal.getSnapshot)
  const [results, setResults] = useState<Record<string, ReceiptResult>>({})
  const [checking, setChecking] = useState<string>()
  const [matching, setMatching] = useState(() => new Set(receipts.map((receipt) => receipt.signature)))
  const [removed, setRemoved] = useState(false)
  const busy = useRef(false)
  const active = useRef(false)
  const generation = useRef(0)

  useLayoutEffect(() => {
    active.current = true
    generation.current += 1
    return () => { active.current = false; generation.current += 1 }
  }, [])

  useLayoutEffect(() => {
    let current = true
    setMatching(new Set(receipts.map((receipt) => receipt.signature)))
    void Promise.all(receipts.map(async (receipt) => {
      const matches = ctx ? await journal.matches(ctx, receipt).catch(() => false) : false
      if (current) setResults((previous) => ({
        ...previous, [receipt.signature]: { matches, confirmation: matches ? previous[receipt.signature]?.confirmation : undefined },
      }))
      if (current) setMatching((previous) => {
        const next = new Set(previous)
        next.delete(receipt.signature)
        return next
      })
    }))
    return () => { current = false }
  }, [ctx, journal, receipts])

  async function recheck(receipt: SubmissionReceipt) {
    if (!ctx || busy.current || !active.current) return
    busy.current = true
    setChecking(receipt.signature)
    const started = generation.current
    const isCurrent = () => active.current && generation.current === started
    try {
      const result = await confirmReceipt(ctx, receipt, journal, isCurrent)
      if (result) setResults((previous) => ({ ...previous, [receipt.signature]: result }))
    } catch {
      if (isCurrent()) setResults((previous) => ({ ...previous, [receipt.signature]: { matches: false } }))
    } finally {
      if (isCurrent()) { busy.current = false; setChecking(undefined) }
    }
  }

  async function removeReceipt(receipt: SubmissionReceipt) {
    const started = generation.current
    setRemoved(false)
    await journal.remove(receipt.signature)
    if (active.current && generation.current === started) setRemoved(true)
  }

  return (
    <Card title={t('receipts.title')}>
      <p className="small muted">{t('receipts.note', receiptLimitParams)}</p>
      <p className="small muted">{t('receipts.scopeNote')}</p>
      <SubmissionHistoryCapacity receipts={receipts} error={journal.error} />
      <SubmissionHistoryExport receipts={receipts} getSnapshot={journal.getSnapshot} />
      {journal.error && <p className="warn-text" role="alert">{t(`receipts.${journal.error}`, receiptLimitParams)}</p>}
      <p className="small" role="status" aria-live="polite" aria-atomic="true">{removed && t('receipts.removed')}</p>
      {receipts.length === 0 && <EmptyState>{t('receipts.empty')}</EmptyState>}
      {receipts.map((receipt) => <SubmissionReceiptView key={receipt.signature} receipt={receipt}
        result={results[receipt.signature]} busy={checking === receipt.signature} disabled={checking !== undefined}
        matching={matching.has(receipt.signature)} onRemove={removeReceipt}
        onRecheck={() => { void recheck(receipt) }} />)}
    </Card>
  )
}

export function SubmissionHistory() {
  const { ctx } = useDesk()
  // A scope change remounts the session and discards every old confirmation reply.
  const scope = ctx ? JSON.stringify([ctx.cluster, ctx.rpcUrl, ctx.programId, ctx.commitment, ctx.deployment]) : 'no-context'
  return <ScopedHistory key={scope} ctx={ctx} />
}
