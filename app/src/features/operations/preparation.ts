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

  constructor(private readonly publish: (state: PreparationState<T>) => void) {}

  private update(state: PreparationState<T>) {
    this.state = state
    if (this.active) this.publish(state)
  }

  setScope(scope: string) {
    if (this.state.scope === scope) return
    this.generation++
    this.update({ scope, planning: false })
  }

  clear() {
    this.generation++
    this.update({ scope: this.state.scope, planning: false })
  }

  isCurrent(scope: string, plan: T) {
    return this.active && this.state.scope === scope && !this.state.planning && this.state.plan === plan
  }

  isActiveScope(scope: string) {
    return this.active && this.state.scope === scope
  }

  async prepare(scope: string, build: () => Promise<T>): Promise<T | undefined> {
    if (!this.active || this.state.scope !== scope || this.state.planning) return undefined
    const generation = ++this.generation
    this.update({ scope, planning: true })
    try {
      const plan = await build()
      if (!this.active || generation !== this.generation) return undefined
      this.update({ scope, planning: false, plan })
      return plan
    } catch {
      // Backend errors can contain endpoints or provider details: expose a static code only.
      if (this.active && generation === this.generation) this.update({ scope, planning: false, error: 'preparation-failed' })
      return undefined
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
