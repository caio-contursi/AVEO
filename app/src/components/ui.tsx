import type { Verdict } from '@aveo/contracts'
import { cloneElement, useId, type AriaAttributes, type ReactElement, type ReactNode } from 'react'
import { useI18n } from '../i18n/context'

export function Card(props: { title?: ReactNode; aside?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={`card ${props.className ?? ''}`}>
      {(props.title || props.aside) && (
        <header className="card-head">
          {props.title && <h2>{props.title}</h2>}
          {props.aside}
        </header>
      )}
      {props.children}
    </section>
  )
}

const VERDICT_TONE: Record<Verdict, string> = { eligible: 'ok', ineligible: 'bad', unknown: 'unknown' }

/** "Não confirmado" usa um tom neutro e tracejado: nunca verde (spec v3, seção 9). */
export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const { t } = useI18n()
  return <span className={`badge ${VERDICT_TONE[verdict]}`}>{t(`verdict.${verdict}`)}</span>
}

export function Badge({ tone = 'neutral', children }: { tone?: 'ok' | 'bad' | 'warn' | 'neutral' | 'unknown' | 'accent'; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />
}

export function LoadingState({ label }: { label?: string }) {
  const { t } = useI18n()
  return (
    <p className="state loading" role="status">
      <Spinner /> {label ?? t('state.loading')}
    </p>
  )
}

export function ErrorState({ title, error, onRetry, children }: { title?: string; error?: unknown; onRetry?: () => void; children?: ReactNode }) {
  const { t } = useI18n()
  const message = error instanceof Error ? error.message : error ? String(error) : undefined
  return (
    <div className="state error" role="alert">
      <strong>{title ?? t('state.error')}</strong>
      {message && <p className="small mono-wrap">{message}</p>}
      {children}
      {onRetry && (
        <button type="button" onClick={onRetry}>
          {t('state.retry')}
        </button>
      )}
    </div>
  )
}

export function EmptyState({ children }: { children?: ReactNode }) {
  const { t } = useI18n()
  return <p className="state empty">{children ?? t('state.empty')}</p>
}

type FieldControl = ReactElement<Pick<AriaAttributes, 'aria-describedby' | 'aria-invalid'> & { id?: string }>

/** Associate supporting text with the actual control, not only its visual label. */
export function Field(props: { label: string; error?: string; hint?: ReactNode; children: FieldControl }) {
  const generatedId = useId()
  const id = props.children.props.id ?? generatedId
  const noteId = `${generatedId}-note`
  const describedBy = [props.children.props['aria-describedby'], props.error || props.hint ? noteId : undefined].filter(Boolean).join(' ') || undefined
  return (
    <label htmlFor={id} className={`field ${props.error ? 'has-error' : ''}`}>
      <span className="field-label">{props.label}</span>
      {cloneElement(props.children, { id, 'aria-describedby': describedBy, 'aria-invalid': props.error ? true : props.children.props['aria-invalid'] })}
      {props.hint && !props.error && <span id={noteId} className="field-hint">{props.hint}</span>}
      {props.error && (
        <span id={noteId} className="field-error" role="alert">
          {props.error}
        </span>
      )}
    </label>
  )
}

/** A named checkbox group must not nest labels inside another label. */
export function FieldGroup(props: { label: string; error?: string; children: ReactNode }) {
  const noteId = useId()
  return (
    <fieldset className={`field ${props.error ? 'has-error' : ''}`} aria-describedby={props.error ? noteId : undefined}>
      <legend className="field-label">{props.label}</legend>
      {props.children}
      {props.error && <span id={noteId} className="field-error" role="alert">{props.error}</span>}
    </fieldset>
  )
}
