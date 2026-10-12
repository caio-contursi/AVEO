import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Field, FieldGroup } from './ui'

describe('accessible form primitives', () => {
  it.each(['input', 'select', 'textarea'])('associates a %s label and hint with its control', (tag) => {
    const html = renderToStaticMarkup(createElement(Field, {
      label: 'Amount', hint: 'Use base units', children: createElement(tag, { id: 'test-control' }),
    }))
    const id = html.match(/for="([^"]+)"/)![1]
    const note = html.match(/aria-describedby="([^"]+)"/)![1]
    expect(html).toContain(`id="${id}"`)
    expect(html).toContain(`id="${note}" class="field-hint"`)
    expect(html).not.toContain('aria-invalid="true"')
  })

  it('links the error instead of the hint and retains supplied control attributes', () => {
    const html = renderToStaticMarkup(createElement(Field, {
      label: 'Amount', error: 'Invalid amount', hint: 'Old hint',
      children: createElement('input', { id: 'amount', 'aria-describedby': 'external-help', type: 'text', disabled: true, readOnly: true, value: '0' }),
    }))
    expect(html).toContain('for="amount"')
    expect(html).toContain('id="amount"')
    expect(html).toContain('aria-invalid="true"')
    const descriptions = html.match(/aria-describedby="([^"]+)"/)![1].split(' ')
    expect(descriptions[0]).toBe('external-help')
    expect(html).toContain(`id="${descriptions[1]}" class="field-error" role="alert"`)
    expect(html).toContain('disabled=""')
    expect(html).toContain('readOnly=""')
    expect(html).toContain('value="0"')
    expect(html).not.toContain('Old hint')
  })

  it('keeps descriptions absent without supporting text and preserves an explicit invalid state', () => {
    const html = renderToStaticMarkup(createElement(Field, {
      label: 'Amount', children: createElement('input', { 'aria-invalid': 'grammar' }),
    }))
    expect(html).not.toContain('aria-describedby')
    expect(html).toContain('aria-invalid="grammar"')
  })

  it('allocates distinct control and note identities for adjacent fields', () => {
    const field = () => createElement(Field, { label: 'Amount', hint: 'Units', children: createElement('input') })
    const html = renderToStaticMarkup(createElement('div', null, field(), field()))
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1])
    expect(ids).toHaveLength(4)
    expect(new Set(ids).size).toBe(4)
  })

  it('gives checkbox groups a legend and linked error without nested labels', () => {
    const html = renderToStaticMarkup(createElement(FieldGroup, {
      label: 'Accepted verifiers', error: 'Select a verifier',
      children: createElement('div', null, createElement('label', null,
        createElement('input', { type: 'checkbox' }), 'Verifier')),
    }))
    expect(html).toContain('<fieldset class="field has-error"')
    expect(html).toContain('<legend class="field-label">Accepted verifiers</legend>')
    expect(html.match(/<label\b/g)).toHaveLength(1)
    const note = html.match(/aria-describedby="([^"]+)"/)![1]
    expect(html).toContain(`id="${note}" class="field-error" role="alert"`)
  })

  it('does not link an absent checkbox-group error', () => {
    const html = renderToStaticMarkup(createElement(FieldGroup, { label: 'Verifiers', children: null }))
    expect(html).not.toContain('aria-describedby')
    expect(html).not.toContain('role="alert"')
  })
})
