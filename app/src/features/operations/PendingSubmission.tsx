import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useDesk } from '../../app/desk'
import { Address } from '../../components/Address'
import { Card, Field } from '../../components/ui'
import { useI18n } from '../../i18n/context'
import { getSubmissionIntentStore } from './submission-intent'
import { recoverPendingSubmission, type SubmissionRecoveryResult } from './submission-recovery'

/** Global send blocker. Recovery only reads the original transaction; it never invokes a wallet. */
export function PendingSubmission() {
  const { ctx } = useDesk()
  const { t } = useI18n()
  const [store] = useState(getSubmissionIntentStore)
  // Use the browser snapshot immediately, including an unresolved record on reload.
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [signature, setSignature] = useState('')
  const [feedback, setFeedback] = useState<{ attemptId?: string; result: SubmissionRecoveryResult }>()
  const [busy, setBusy] = useState(false)
  const active = useRef(false)
  const running = useRef(false)
  const generation = useRef(0)
  const contextKey = ctx ? JSON.stringify([ctx.cluster, ctx.rpcUrl, ctx.programId, ctx.commitment, ctx.deployment]) : ''
  useLayoutEffect(() => {
    active.current = true
    generation.current += 1
    running.current = false
    setBusy(false)
    setFeedback(undefined)
    setSignature('')
    return () => { active.current = false; generation.current += 1; running.current = false }
  }, [contextKey])

  const intent = snapshot.intent
  const result = feedback && (!intent || feedback.attemptId === intent.attemptId) ? feedback.result : undefined
  const recoverable = intent?.phase === 'wallet-invoked' && !!intent.messageFingerprint
  async function check() {
    if (!ctx || !recoverable || running.current || !active.current) return
    const attempt = intent
    // Read the store before starting: a notification may precede React's next render.
    if (store.getSnapshot().intent?.attemptId !== attempt.attemptId) return
    running.current = true
    const started = ++generation.current
    const isCurrent = () => {
      const latest = store.getSnapshot().intent
      // Signature attachment and terminal settlement are expected controller updates.
      return active.current && generation.current === started && (!latest || (
        latest.attemptId === attempt.attemptId && latest.contextFingerprint === attempt.contextFingerprint &&
        latest.messageFingerprint === attempt.messageFingerprint && latest.signer === attempt.signer && latest.kind === attempt.kind
      ))
    }
    setBusy(true)
    setFeedback(undefined)
    try {
      const next = await recoverPendingSubmission(ctx, { store, ...(attempt.signature ? {} : { signature: signature.trim() }), isCurrent })
      if (isCurrent()) setFeedback({ attemptId: attempt.attemptId, result: next })
    } catch {
      if (isCurrent()) setFeedback({ attemptId: attempt.attemptId, result: { status: 'unknown' } })
    } finally {
      if (active.current && generation.current === started) { running.current = false; setBusy(false) }
    }
  }

  if (!intent && !snapshot.error && !busy && !result) return null
  return <Card title={t('pending.title')}>
    <p className="small muted">{t('pending.readOnly')}</p>
    {snapshot.error && <p className="warn-text" role="alert">{t('pending.storageWarning')}</p>}
    {intent && <>
      <p className="warn-text">{t(recoverable ? 'pending.unresolved' : 'pending.reserved')}</p>
      {intent.signature
        ? <Field label={t('pending.signature')}><input aria-label={t('pending.signature')} readOnly value={intent.signature} /></Field>
        : recoverable && <Field label={t('pending.pasteSignature')} hint={t('pending.signatureHint')}>
          <input aria-label={t('pending.pasteSignature')} value={signature} maxLength={88} autoComplete="off" spellCheck={false} disabled={busy}
            onChange={(event) => setSignature(event.currentTarget.value.slice(0, 88))} />
        </Field>}
      {!ctx && <p className="warn-text">{t('pending.noContext')}</p>}
      {recoverable && <div className="actions"><button type="button" disabled={!ctx || (!intent.signature && !signature.trim())}
        aria-disabled={busy || undefined} aria-busy={busy || undefined} onClick={() => { void check() }}>
        {t(intent.signature ? 'pending.check' : 'pending.validate')}
      </button></div>}
    </>}
    <div role="status" aria-live="polite" aria-atomic="true">
      {busy ? <p>{t('pending.checking')}</p> : result && <>
        <p>{t(`pending.${result.status}`)}</p>
        {!intent && result.signature && <Address value={result.signature} />}
      </>}
    </div>
  </Card>
}
