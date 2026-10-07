import { useState } from 'react'
import { useI18n } from '../i18n/context'
import { shortAddress } from './format'

type CopyState = 'idle' | 'copied' | 'failed'

/** Clipboard API primeiro; sem ela (permissão, contexto inseguro), o comando antigo de copiar. */
async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    // segue para o comando antigo
  }
  const area = document.createElement('textarea')
  area.value = value
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    area.remove()
  }
}

/** Endereço em fonte monoespaçada, com o valor completo no title e botão de copiar. */
export function Address({ value, short = false, plain = false }: { value: string; short?: boolean; plain?: boolean }) {
  const { t } = useI18n()
  const [state, setState] = useState<CopyState>('idle')
  const text = short ? shortAddress(value) : value
  if (plain) {
    return (
      <code className="addr plain" title={value}>
        {text}
      </code>
    )
  }
  const label = state === 'copied' ? t('copy.done') : state === 'failed' ? t('copy.failed') : t('copy.label', { value: text })
  return (
    <span className="addr-wrap">
      <code className="addr" title={value}>
        {text}
      </code>
      <button
        type="button"
        className={`copy ${state}`}
        aria-label={label}
        title={label}
        onClick={() => {
          void copyText(value).then((ok) => {
            setState(ok ? 'copied' : 'failed')
            setTimeout(() => setState('idle'), ok ? 1200 : 3000)
          })
        }}
      >
        {state === 'copied' ? '✓' : state === 'failed' ? '✗' : '⧉'}
      </button>
      <span className="sr-only" aria-live="polite">
        {state === 'idle' ? '' : label}
      </span>
    </span>
  )
}
