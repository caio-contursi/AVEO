export interface PreparationState<T> {
  scope?: string
  planning: boolean
  plan?: T
  error?: 'preparation-failed'
}

/** Read-only preparation: invalidate obsolete replies, never sign, send or retry. */
export class PlanPreparation<T> {
  state: PreparationState<T> = { planning: false }
  private generation = 0
  private active = true
  private controller?: AbortController

  constructor(private readonly publish: (state: PreparationState<T>) => void) {}

  private update(state: PreparationState<T>) {
    this.state = state
    if (this.active) this.publish(state)
  }

  setScope(scope: string) {
    if (this.state.scope === scope) return
    this.generation++
    this.abortPending()
    this.update({ scope, planning: false })
  }

  clear() {
    this.generation++
    this.abortPending()
    this.update({ scope: this.state.scope, planning: false })
  }

  isCurrent(scope: string, plan: T) {
    return this.active && this.state.scope === scope && !this.state.planning && this.state.plan === plan
  }

  isActiveScope(scope: string) {
    return this.active && this.state.scope === scope
  }

  private abortPending() {
    const controller = this.controller
    this.controller = undefined
    controller?.abort()
  }

  async prepare(scope: string, build: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    if (!this.active || this.state.scope !== scope || this.state.planning) return undefined
    const generation = ++this.generation
    const controller = new AbortController()
    this.controller = controller
    const { signal } = controller
    let onAbort!: () => void
    const cancelled = new Promise<undefined>((resolve) => {
      onAbort = () => resolve(undefined)
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      this.update({ scope, planning: true })
      // Publishing can synchronously invalidate this request before the builder runs.
      if (signal.aborted) return undefined
      const plan = await Promise.race([build(signal), cancelled])
      if (signal.aborted || !this.active || generation !== this.generation) return undefined
      this.update({ scope, planning: false, plan })
      return plan
    } catch {
      // Backend errors can contain endpoints or provider details: expose a static code only.
      if (!signal.aborted && this.active && generation === this.generation) this.update({ scope, planning: false, error: 'preparation-failed' })
      return undefined
    } finally {
      signal.removeEventListener('abort', onAbort)
      // An obsolete completion must not release a newer request's controller.
      if (this.controller === controller) this.controller = undefined
    }
  }

  activate() {
    this.active = true
    this.publish(this.state)
  }

  deactivate() {
    this.active = false
    this.clear()
  }
}
