import { useCallback, useLayoutEffect, useState } from 'react'
import { PlanPreparation, type PreparationState } from './preparation'

/** Scope is private comparison data, never persisted or displayed. */
export function usePlanPreparation<T>(scope: readonly unknown[]) {
  const key = JSON.stringify(scope)
  const [state, setState] = useState<PreparationState<T>>({ planning: false })
  const [preparation] = useState(() => new PlanPreparation<T>(setState))

  useLayoutEffect(() => {
    preparation.activate()
    return () => preparation.deactivate()
  }, [preparation])
  useLayoutEffect(() => { preparation.setScope(key) }, [preparation, key])

  const prepare = useCallback((build: () => Promise<T>) => preparation.prepare(key, build), [preparation, key])
  const clear = useCallback(() => preparation.clear(), [preparation])
  const isCurrent = useCallback((plan: T) => preparation.isCurrent(key, plan), [preparation, key])
  // Hide the old plan during render, before the scope-changing layout effect runs.
  const visible: PreparationState<T> = state.scope === key ? state : { planning: false }
  return { plan: visible.plan, planning: visible.planning, error: visible.error, prepare, clear, isCurrent }
}
