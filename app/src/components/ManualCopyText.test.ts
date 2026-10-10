import type { ButtonHTMLAttributes, ReactElement, TextareaHTMLAttributes } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ManualCopyText } from './ManualCopyText'

const mocks = vi.hoisted(() => ({ current: null as HTMLTextAreaElement | null }))
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useId: () => 'manual-json',
  useRef: () => mocks,
}))

function controls() {
  const view = ManualCopyText({ text: '{"public": true}', label: 'Public JSON', selectLabel: 'Select JSON to copy' })
  const children = view.props.children as ReactElement[]
  return {
    textarea: children[1] as ReactElement<TextareaHTMLAttributes<HTMLTextAreaElement>>,
    button: children[2] as ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>,
  }
}

beforeEach(() => { mocks.current = null })

describe('explicit manual JSON selection', () => {
  it('focuses before selecting the whole value only when the native button is activated', () => {
    const calls: string[] = []
    const focus = vi.fn(() => { calls.push('focus') })
    const select = vi.fn(() => { calls.push('select') })
    mocks.current = { focus, select } as unknown as HTMLTextAreaElement
    const { textarea, button } = controls()
    expect(calls).toEqual([])
    expect(textarea.props).toMatchObject({ readOnly: true, value: '{"public": true}' })
    expect(textarea.props.autoFocus).toBeUndefined()
    expect(button.type).toBe('button')
    expect(button.props.type).toBe('button')
    button.props.onClick!({} as Parameters<NonNullable<typeof button.props.onClick>>[0])
    expect(calls).toEqual(['focus', 'select'])
    expect(select).toHaveBeenCalledWith()
  })

  it('safely ignores activation when the textarea ref is absent', () => {
    const { button } = controls()
    expect(() => button.props.onClick!({} as Parameters<NonNullable<typeof button.props.onClick>>[0])).not.toThrow()
  })

  it('preserves select-all when the textarea receives focus directly', () => {
    const select = vi.fn()
    const { textarea } = controls()
    textarea.props.onFocus!({ currentTarget: { select } } as unknown as Parameters<NonNullable<typeof textarea.props.onFocus>>[0])
    expect(select).toHaveBeenCalledExactlyOnceWith()
  })
})
