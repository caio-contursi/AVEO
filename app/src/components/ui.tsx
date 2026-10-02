import type { Verdict } from '@aveo/contracts'
import type { ReactNode } from 'react'
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

export function Field(props: { label: string; error?: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className={`field ${props.error ? 'has-error' : ''}`}>
      <span className="field-label">{props.label}</span>
      {props.children}
      {props.hint && !props.error && <span className="field-hint">{props.hint}</span>}
      {props.error && (
        <span className="field-error" role="alert">
          {props.error}
        </span>
      )}
    </label>
  )
}
