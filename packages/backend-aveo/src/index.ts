import type { Capability } from '@aveo/contracts'

/** Rota B. `refreeze` stays on the MPL adapter, which is not integrated. */
export const AVEO_BACKEND_CAPABILITIES = ['transfer', 'renew-binding'] as const satisfies readonly Capability[]

/**
 * Mints covered by one `planRenewBinding`. Several mints share one transaction
 * and one signature. Callers that still pass only `mint` keep the old behavior.
 */
export function renewalMints(input: { mint: string; mints?: readonly string[] }): string[] {
  const source = input.mints && input.mints.length > 0 ? input.mints : [input.mint]
  return [...new Set(source.filter((mint) => mint.length > 0))]
}

/**
 * A binding the policy never accepted (T02/T03) is a diagnosis, not an incident.
 * Losing a pair or a required fact after the wallet was eligible (T08) is an incident.
 */
export function isStandingPolicyRejection(code: string, previouslyEligible: boolean): boolean {
  if (previouslyEligible) return false
  return code === 'ProviderPairNotAllowed' || code === 'RequiredFactMissing'
}
