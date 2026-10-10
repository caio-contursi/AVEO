import { describe, expect, it } from 'vitest'
import { DEMO_ACCEPTANCE_MANIFEST } from './acceptance-stages'
import { AUTHORIZATION_STAGES } from './authorization-checks'
import { BOUNDARY_STAGES } from './boundary-checks'
import { FALSE_KYC_STAGES } from './kyc-checks'
import { PERSISTENCE_STAGES } from './persistence-check'
import { SCHEMA_VALIDITY_STAGES } from './schema-validity-checks'
import { SAS_ADVERSARIAL_STAGES } from './sas-adversarial-checks'
import { MISSING_BINDING_STAGES } from './missing-binding-checks'

// Pin the existing emission order independently of the producer and consumer aliases.
const versionOneOrder = `
localnet-preconditions
shared-proof-X
successful-transfers
external-with-extra-accounts
external-without-extra-accounts
direct-hook-execute-rejected
unsigned-policy-update-rejected
unsigned-binding-rejected
boundary-zero-amount
boundary-excessive-amount
boundary-max-u64-rejected
boundary-exact-balance
boundary-same-owner-distinct-accounts
boundary-fixtures-restored
delegate-approved-owner-transfer
policy-differences-Y-B-Z
non-issuer-policy-update-rejected
wrong-subject-binding-rejected
false-kyc-proof-bound
false-kyc-transfers-rejected
false-kyc-original-bindings-restored
close-X-proofs
rejected-transfers-unchanged-balances
scan-grouping
persistence-initial-save
persistence-process-restart
persistence-repeated-scan
issue-renewal-proof
signed-batched-rebind
fresh-readback
renewed-successful-transfers
issuer-removes-A-alfa-only
issuer-restores-alfa-policy
issuer-inactivates-alfa-only
issuer-restores-active-alfa-policy
short-lived-X-proof-bound
validator-clock-reaches-expiry
expired-proof-rejects-both-directions
external-expired-proof-rejected
delegate-expired-owner-rejected
valid-X-proof-bindings-restored
delegate-approval-revoked
`.trim().split('\n')

describe('demo acceptance manifest', () => {
  it('preserves the original order and versions the appended adversarial stages', () => {
    expect(DEMO_ACCEPTANCE_MANIFEST.version).toBe(3)
    expect(DEMO_ACCEPTANCE_MANIFEST.stageIds).toEqual([...versionOneOrder, ...SCHEMA_VALIDITY_STAGES, ...SAS_ADVERSARIAL_STAGES, ...MISSING_BINDING_STAGES])
  })

  it('contains unique, nonempty IDs accepted by the runner metadata parser', () => {
    const { stageIds } = DEMO_ACCEPTANCE_MANIFEST
    expect(new Set(stageIds).size).toBe(stageIds.length)
    expect(stageIds.every((id) => /^[a-zA-Z0-9-]+$/.test(id) && id.length <= 100)).toBe(true)
  })

  it.each([
    { name: 'authorization', start: 5, ids: AUTHORIZATION_STAGES },
    { name: 'boundary', start: 8, ids: BOUNDARY_STAGES },
    { name: 'false KYC', start: 18, ids: FALSE_KYC_STAGES },
    { name: 'persistence', start: 24, ids: PERSISTENCE_STAGES },
  ])('preserves the $name helper completion order at its original position', ({ start, ids }) => {
    expect(DEMO_ACCEPTANCE_MANIFEST.stageIds.slice(start, start + ids.length)).toEqual(ids)
  })

  it('freezes the manifest and its stage list against shared-contract mutations', () => {
    const { stageIds } = DEMO_ACCEPTANCE_MANIFEST
    expect(Object.isFrozen(DEMO_ACCEPTANCE_MANIFEST)).toBe(true)
    expect(Object.isFrozen(stageIds)).toBe(true)
    expect(Reflect.set(DEMO_ACCEPTANCE_MANIFEST, 'version', 2)).toBe(false)
    expect(Reflect.set(DEMO_ACCEPTANCE_MANIFEST, 'stageIds', [])).toBe(false)
    expect(Reflect.set(stageIds, '0', 'unexpected')).toBe(false)
    expect(Reflect.set(stageIds, 'length', 0)).toBe(false)
    expect(() => Array.prototype.push.call(stageIds, 'unexpected')).toThrow(TypeError)
    expect(DEMO_ACCEPTANCE_MANIFEST.stageIds).toEqual([...versionOneOrder, ...SCHEMA_VALIDITY_STAGES, ...SAS_ADVERSARIAL_STAGES, ...MISSING_BINDING_STAGES])
  })
})
