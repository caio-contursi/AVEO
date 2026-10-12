import { describe, expect, it, vi } from 'vitest'
import { PlanPreparation } from './preparation'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

function setup() {
  const publish = vi.fn()
  const preparation = new PlanPreparation<{ intent: string }>(publish)
  preparation.setScope('first-scope')
  publish.mockClear()
  return { preparation, publish }
}

describe('read-only plan preparation lifecycle', () => {
  it.each(['clear', 'scope', 'deactivate'] as const)('settles promptly on %s even when transport ignores cancellation', async (action) => {
    const { preparation, publish } = setup()
    const reply = deferred<{ intent: string }>()
    let signal!: AbortSignal
    const request = preparation.prepare('first-scope', (received) => {
      signal = received
      return reply.promise
    })
    const remove = vi.spyOn(signal, 'removeEventListener')
    publish.mockClear()
    if (action === 'clear') preparation.clear()
    else if (action === 'scope') preparation.setScope('next-scope')
    else preparation.deactivate()
    expect(signal.aborted).toBe(true)
    // The transport is still pending: cancellation itself must settle the request.
    await expect(request).resolves.toBeUndefined()
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(preparation.state.planning).toBe(false)
    expect(preparation.state.error).toBeUndefined()
    expect(publish).toHaveBeenCalledTimes(action === 'deactivate' ? 0 : 1)
    publish.mockClear()
    reply.reject(new Error('late private transport failure'))
    await Promise.resolve()
    await Promise.resolve()
    expect(publish).not.toHaveBeenCalled()
  })

  it('gives accepted reads unique signals and preserves the new controller after old completion', async () => {
    const { preparation } = setup()
    const old = deferred<{ intent: string }>()
    const next = deferred<{ intent: string }>()
    let oldSignal!: AbortSignal, nextSignal!: AbortSignal
    const first = preparation.prepare('first-scope', (signal) => {
      oldSignal = signal
      return old.promise
    })
    const duplicate = vi.fn(async () => ({ intent: 'duplicate' }))
    await expect(preparation.prepare('first-scope', duplicate)).resolves.toBeUndefined()
    expect(duplicate).not.toHaveBeenCalled()
    expect(oldSignal.aborted).toBe(false)
    preparation.clear()
    const second = preparation.prepare('first-scope', (signal) => {
      nextSignal = signal
      return next.promise
    })
    await expect(first).resolves.toBeUndefined()
    expect(nextSignal).not.toBe(oldSignal)
    expect(nextSignal.aborted).toBe(false)
    old.resolve({ intent: 'obsolete' })
    await Promise.resolve()
    preparation.clear()
    expect(nextSignal.aborted).toBe(true)
    await expect(second).resolves.toBeUndefined()
  })

  it('keeps completed signals un-aborted and removes their cancellation listeners', async () => {
    const { preparation } = setup()
    let signal!: AbortSignal
    let remove!: ReturnType<typeof vi.spyOn>
    const plan = { intent: 'complete' }
    await expect(preparation.prepare('first-scope', (received) => {
      signal = received
      remove = vi.spyOn(signal, 'removeEventListener')
      return Promise.resolve(plan)
    })).resolves.toBe(plan)
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    preparation.clear()
    preparation.setScope('next-scope')
    preparation.deactivate()
    expect(signal.aborted).toBe(false)
  })

  it('removes the cancellation listener after a synchronous sanitized failure', async () => {
    const { preparation } = setup()
    let signal!: AbortSignal
    let remove!: ReturnType<typeof vi.spyOn>
    await expect(preparation.prepare('first-scope', (received) => {
      signal = received
      remove = vi.spyOn(signal, 'removeEventListener')
      throw new Error('private endpoint')
    })).resolves.toBeUndefined()
    expect(preparation.state.error).toBe('preparation-failed')
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    preparation.clear()
    expect(signal.aborted).toBe(false)
  })

  it('does not invoke the builder if publishing already cancelled its signal', async () => {
    const publish = vi.fn((state: { planning: boolean }) => {
      if (state.planning) preparation.clear()
    })
    const preparation = new PlanPreparation<{ intent: string }>(publish)
    preparation.setScope('first-scope')
    const build = vi.fn(async () => ({ intent: 'unexpected' }))
    await expect(preparation.prepare('first-scope', build)).resolves.toBeUndefined()
    expect(build).not.toHaveBeenCalled()
    expect(preparation.state).toEqual({ scope: 'first-scope', planning: false })
  })

  it('aborts only the previous mount when deactivated and reactivated', async () => {
    const { preparation, publish } = setup()
    const reply = deferred<{ intent: string }>()
    let previous!: AbortSignal, current!: AbortSignal
    const old = preparation.prepare('first-scope', (signal) => {
      previous = signal
      return reply.promise
    })
    publish.mockClear()
    preparation.deactivate()
    expect(publish).not.toHaveBeenCalled()
    preparation.activate()
    const next = preparation.prepare('first-scope', (signal) => {
      current = signal
      return new Promise(() => {})
    })
    await expect(old).resolves.toBeUndefined()
    expect(previous.aborted).toBe(true)
    expect(current.aborted).toBe(false)
    reply.reject(new Error('obsolete'))
    await Promise.resolve()
    preparation.clear()
    expect(current.aborted).toBe(true)
    await expect(next).resolves.toBeUndefined()
  })

  it('checks active scope independently of an in-flight plan and rejects detached scopes', async () => {
    const { preparation } = setup()
    const reply = deferred<{ intent: string }>()
    const request = preparation.prepare('first-scope', () => reply.promise)
    expect(preparation.isActiveScope('first-scope')).toBe(true)
    expect(preparation.isActiveScope('other-scope')).toBe(false)
    preparation.setScope('other-scope')
    expect(preparation.isActiveScope('first-scope')).toBe(false)
    expect(preparation.isActiveScope('other-scope')).toBe(true)
    preparation.deactivate()
    expect(preparation.isActiveScope('other-scope')).toBe(false)
    reply.resolve({ intent: 'obsolete' })
    expect(await request).toBeUndefined()
  })
  it('publishes the current plan only after preparation completes', async () => {
    const { preparation, publish } = setup()
    const reply = deferred<{ intent: string }>()
    const request = preparation.prepare('first-scope', () => reply.promise)
    expect(preparation.state).toEqual({ scope: 'first-scope', planning: true })
    const plan = { intent: 'transfer' }
    expect(preparation.isCurrent('first-scope', plan)).toBe(false)
    reply.resolve(plan)
    expect(await request).toBe(plan)
    expect(preparation.state).toEqual({ scope: 'first-scope', planning: false, plan })
    expect(preparation.isCurrent('first-scope', plan)).toBe(true)
    expect(preparation.isCurrent('first-scope', { ...plan })).toBe(false)
    expect(preparation.isCurrent('other-scope', plan)).toBe(false)
    expect(publish).toHaveBeenCalledTimes(2)
  })

  it('synchronously blocks duplicate clicks before the UI rerenders', async () => {
    const { preparation } = setup()
    const reply = deferred<{ intent: string }>()
    const build = vi.fn(() => reply.promise)
    const first = preparation.prepare('first-scope', build)
    expect(await preparation.prepare('first-scope', build)).toBeUndefined()
    expect(build).toHaveBeenCalledTimes(1)
    reply.resolve({ intent: 'binding' })
    await first
  })

  it('clears a previously prepared plan before starting another simulation', async () => {
    const { preparation } = setup()
    const old = { intent: 'old' }
    await preparation.prepare('first-scope', async () => old)
    const reply = deferred<{ intent: string }>()
    const next = preparation.prepare('first-scope', () => reply.promise)
    expect(preparation.state.plan).toBeUndefined()
    expect(preparation.isCurrent('first-scope', old)).toBe(false)
    reply.resolve({ intent: 'new' })
    await next
  })

  it.each(['form', 'wallet', 'cluster', 'rpc', 'program', 'commitment', 'deployment', 'proof', 'policy'])('discards late replies after a %s scope change', async (field) => {
    const { preparation, publish } = setup()
    const reply = deferred<{ intent: string }>()
    const request = preparation.prepare('first-scope', () => reply.promise)
    preparation.setScope(`${field}-changed`)
    publish.mockClear()
    const old = { intent: 'old' }
    reply.resolve(old)
    expect(await request).toBeUndefined()
    expect(publish).not.toHaveBeenCalled()
    expect(preparation.state).toEqual({ scope: `${field}-changed`, planning: false })
    expect(preparation.isCurrent('first-scope', old)).toBe(false)
  })

  it.each(['resolve', 'reject'] as const)('keeps a newer preparation intact when an obsolete one later %ss', async (outcome) => {
    const { preparation, publish } = setup()
    const old = deferred<{ intent: string }>(), next = deferred<{ intent: string }>()
    const first = preparation.prepare('first-scope', () => old.promise)
    preparation.clear()
    const second = preparation.prepare('first-scope', () => next.promise)
    publish.mockClear()
    if (outcome === 'resolve') old.resolve({ intent: 'old' })
    else old.reject(new Error('private endpoint'))
    expect(await first).toBeUndefined()
    expect(preparation.state.planning).toBe(true)
    expect(publish).not.toHaveBeenCalled()
    const plan = { intent: 'new' }
    next.resolve(plan)
    expect(await second).toBe(plan)
    expect(preparation.state.plan).toBe(plan)
  })

  it('does not resurrect an A-scope reply after switching A to B to A', async () => {
    const { preparation } = setup()
    const reply = deferred<{ intent: string }>()
    const request = preparation.prepare('first-scope', () => reply.promise)
    preparation.setScope('second-scope')
    preparation.setScope('first-scope')
    reply.resolve({ intent: 'obsolete A' })
    expect(await request).toBeUndefined()
    expect(preparation.state.plan).toBeUndefined()
  })

  it.each([new Error('https://private-rpc/?token=secret'), 'secret', null, { logs: ['private'] }])('exposes only a static failure code and allows an explicit retry', async (error) => {
    const { preparation, publish } = setup()
    expect(await preparation.prepare('first-scope', async () => { throw error })).toBeUndefined()
    expect(preparation.state).toEqual({ scope: 'first-scope', planning: false, error: 'preparation-failed' })
    expect(JSON.stringify(publish.mock.calls)).not.toContain('secret')
    const plan = { intent: 'retry' }
    expect(await preparation.prepare('first-scope', async () => plan)).toBe(plan)
    expect(preparation.state.error).toBeUndefined()
  })

  it('catches a synchronous builder throw without leaking provider details', async () => {
    const { preparation } = setup()
    await expect(preparation.prepare('first-scope', () => { throw new Error('private') })).resolves.toBeUndefined()
    expect(preparation.state.error).toBe('preparation-failed')
  })

  it.each(['resolve', 'reject'] as const)('does not publish after unmount when an old promise %ss', async (outcome) => {
    const { preparation, publish } = setup()
    const reply = deferred<{ intent: string }>()
    const request = preparation.prepare('first-scope', () => reply.promise)
    preparation.deactivate()
    publish.mockClear()
    if (outcome === 'resolve') reply.resolve({ intent: 'late' })
    else reply.reject(new Error('private'))
    expect(await request).toBeUndefined()
    expect(publish).not.toHaveBeenCalled()
    expect(preparation.state).toEqual({ scope: 'first-scope', planning: false })
  })

  it('does not build with a stale callback scope or while inactive', async () => {
    const { preparation } = setup()
    const build = vi.fn(async () => ({ intent: 'unexpected' }))
    expect(await preparation.prepare('other-scope', build)).toBeUndefined()
    preparation.deactivate()
    expect(await preparation.prepare('first-scope', build)).toBeUndefined()
    expect(build).not.toHaveBeenCalled()
  })

  it('reactivates with cleared state and rejects promises from a previous mount', async () => {
    const { preparation, publish } = setup()
    const reply = deferred<{ intent: string }>()
    const old = preparation.prepare('first-scope', () => reply.promise)
    preparation.deactivate()
    preparation.activate()
    expect(publish).toHaveBeenLastCalledWith({ scope: 'first-scope', planning: false })
    const current = { intent: 'current mount' }
    await preparation.prepare('first-scope', async () => current)
    reply.resolve({ intent: 'previous mount' })
    expect(await old).toBeUndefined()
    expect(preparation.state.plan).toBe(current)
  })

  it('keeps an in-flight request when the scope remains identical', async () => {
    const { preparation } = setup()
    const reply = deferred<{ intent: string }>()
    let signal!: AbortSignal
    const request = preparation.prepare('first-scope', (received) => {
      signal = received
      return reply.promise
    })
    preparation.setScope('first-scope')
    expect(signal.aborted).toBe(false)
    const plan = { intent: 'same scope' }
    reply.resolve(plan)
    expect(await request).toBe(plan)
  })
})
