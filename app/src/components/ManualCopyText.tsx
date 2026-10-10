import { useId, useRef } from 'react'

export function ManualCopyText({ text, label, selectLabel }: {
  text: string; label: string; selectLabel: string
}) {
  const id = useId()
  const textarea = useRef<HTMLTextAreaElement>(null)

  function selectText() {
    const control = textarea.current
    if (!control) return
    control.focus()
    control.select()
  }

  return <div>
    <label htmlFor={id}>{label}</label>
    <textarea id={id} ref={textarea} readOnly rows={16} value={text}
      onFocus={(event) => { event.currentTarget.select() }} />
    <button type="button" onClick={selectText}>{selectLabel}</button>
  </div>
}
