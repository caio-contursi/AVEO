import { useState } from 'react'
import { shortAddress } from './format'

/** Endereço em fonte monoespaçada, com o valor completo no title e botão de copiar. */
export function Address({ value, short = false, plain = false }: { value: string; short?: boolean; plain?: boolean }) {
  const [copied, setCopied] = useState(false)
  const text = short ? shortAddress(value) : value
  if (plain) {
    return (
      <code className="addr plain" title={value}>
        {text}
      </code>
    )
  }
  return (
    <span className="addr-wrap">
      <code className="addr" title={value}>
        {text}
      </code>
      <button
        type="button"
        className="copy"
        aria-label="copy"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          })
        }}
      >
        {copied ? '✓' : '⧉'}
      </button>
    </span>
  )
}
