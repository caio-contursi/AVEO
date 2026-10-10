import { describe, expect, it, vi } from 'vitest'
import { throwIfReadAborted, withReadAbort } from './cancellation'

describe('read cancellation', () => {
  it('rejects before invoking a pre-aborted read and sanitizes its reason', async () => {
    const controller = new AbortController()
    controller.abort(new Error('secret endpoint'))
    const read = vi.fn()
    await expect(withReadAbort(controller.signal, read)).rejects.toMatchObject({
      name: 'AbortError', message: 'Read cancelled.',
    })
    expect(read).not.toHaveBeenCalled()
    expect(() => throwIfReadAborted(controller.signal)).toThrow(DOMException)
  })

  it('allows absent and active signals', async () => {
    expect(() => throwIfReadAborted(undefined)).not.toThrow()
    expect(() => throwIfReadAborted(new AbortController().signal)).not.toThrow()
    await expect(withReadAbort(undefined, async () => 42)).resolves.toBe(42)
  })

  it.each([false, true])('preserves original read errors with a signal: %s', async (withSignal) => {
    const signal = withSignal ? new AbortController().signal : undefined
    const error = new Error('original read error')
    await expect(withReadAbort(signal, async () => { throw error })).rejects.toBe(error)
    await expect(withReadAbort(signal, () => { throw error })).rejects.toBe(error)
  })

  it('observes cancellation triggered synchronously inside the read callback', async () => {
    const controller = new AbortController()
    await expect(withReadAbort(controller.signal, () => {
      controller.abort('secret reason')
      return Promise.reject(new Error('secret provider details'))
    })).rejects.toMatchObject({ name: 'AbortError', message: 'Read cancelled.' })
  })

  it.each(['success', 'failure', 'synchronous failure', 'abort'] as const)(
    'removes its listener after %s', async (outcome) => {
      const controller = new AbortController()
      const add = vi.spyOn(controller.signal, 'addEventListener')
      const remove = vi.spyOn(controller.signal, 'removeEventListener')
      const error = new Error('original error')
      const result = withReadAbort(controller.signal, () => {
        if (outcome === 'synchronous failure') throw error
        if (outcome === 'failure') return Promise.reject(error)
        if (outcome === 'abort') return new Promise<never>(() => {})
        return Promise.resolve(42)
      })
      if (outcome === 'abort') controller.abort('secret reason')
      if (outcome === 'success') await expect(result).resolves.toBe(42)
      else if (outcome === 'abort') await expect(result).rejects.toMatchObject({ name: 'AbortError' })
      else await expect(result).rejects.toBe(error)
      expect(add).toHaveBeenCalledTimes(1)
      expect(remove).toHaveBeenCalledExactlyOnceWith('abort', add.mock.calls[0]![1])
    },
  )

  it.each(['resolve', 'reject'] as const)('handles late %s after prompt cancellation', async (outcome) => {
    const controller = new AbortController()
    let resolveRead!: (value: number) => void
    let rejectRead!: (reason: Error) => void
    const result = withReadAbort(controller.signal, () => new Promise<number>((resolve, reject) => {
      resolveRead = resolve
      rejectRead = reject
    }))
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      controller.abort('secret reason')
      await expect(result).rejects.toMatchObject({ name: 'AbortError', message: 'Read cancelled.' })
      if (outcome === 'resolve') resolveRead(42)
      else rejectRead(new Error('secret transport details'))
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(unhandled).not.toHaveBeenCalled()
      await expect(result).rejects.toBeInstanceOf(DOMException)
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
})
