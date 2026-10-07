import assert from 'node:assert/strict'
import test from 'node:test'
import { isStandingPolicyRejection, renewalMints } from './index.ts'

test('one mint stays one transaction target', () => {
  assert.deepEqual(renewalMints({ mint: 'alfa' }), ['alfa'])
})

test('several mints collapse into one list without duplicates', () => {
  assert.deepEqual(renewalMints({ mint: 'alfa', mints: ['alfa', 'beta', 'alfa'] }), ['alfa', 'beta'])
})

test('a pair the policy never accepted is not an incident', () => {
  assert.equal(isStandingPolicyRejection('ProviderPairNotAllowed', false), true)
  assert.equal(isStandingPolicyRejection('RequiredFactMissing', false), true)
  assert.equal(isStandingPolicyRejection('ProviderPairNotAllowed', true), false)
  assert.equal(isStandingPolicyRejection('AttestationExpired', false), false)
})
