import assert from 'node:assert/strict'
import test from 'node:test'
import { DeskError } from '@aveo/contracts'
import type { EligibilityBackend, EligibilitySnapshot, OperationEvidence, TransferInput, UnsignedPlan, VerifyInput } from '@aveo/contracts'
import { inspectTransfer, prepareTransfer, verifyPreparedTransfer } from './integration.ts'

const input: TransferInput = {
  cluster: 'localnet', mint: 'mint', sourceOwner: 'source', destinationOwner: 'destination', amount: 7n,
}

function snapshot(wallet: string): EligibilitySnapshot {
  return {
    backend: 'aveo-sas-hook', mint: input.mint, wallet, verdict: 'eligible',
    read: { cluster: 'localnet', rpcUrl: 'http://127.0.0.1:8899', slot: 42, commitment: 'confirmed', observedAt: '2026-10-10T12:00:00Z' },
    reasons: [], sourceAccounts: {}, actions: ['transfer'],
  }
}

function setup() {
  const plan: UnsignedPlan = {
    backend: 'aveo-sas-hook', transaction: 'b3BhcXVl', requiredSigners: ['source'], summary: [],
    diagnostics: { source: snapshot('source'), destination: snapshot('destination') },
  }
  const evidence: OperationEvidence = { status: 'unknown', signature: 'signature', logs: ['pending'],
    error: { code: 'ConfirmationUnknown', message: 'Confirmation unavailable.' } }
  const calls: string[] = []
  const backend: EligibilityBackend = {
    id: 'aveo-sas-hook',
    capabilities: () => ['transfer'],
    inspect: async (request) => {
      calls.push(`inspect:${request.wallet}`)
      assert.deepEqual(request, { cluster: input.cluster, mint: input.mint, wallet: request.wallet })
      return request.wallet === 'source' ? plan.diagnostics.source : plan.diagnostics.destination
    },
    planTransfer: async (request) => { calls.push('plan'); assert.equal(request, input); return plan },
    verifyOutcome: async (request) => {
      calls.push('verify')
      assert.deepEqual(request, { cluster: input.cluster, plan, signature: 'signature' })
      return evidence
    },
  }
  return { backend, plan, evidence, calls }
}

test('independent diagnosis, planning and verification preserve native results and call order', async () => {
  const { backend, plan, evidence, calls } = setup()
  const diagnostics = await inspectTransfer(backend, input)
  assert.equal(diagnostics.source, plan.diagnostics.source)
  assert.equal(diagnostics.destination, plan.diagnostics.destination)
  assert.equal(await prepareTransfer(backend, input), plan)
  assert.equal(await verifyPreparedTransfer(backend, plan, 'localnet', 'signature'), evidence)
  assert.deepEqual(calls, ['inspect:source', 'inspect:destination', 'plan', 'verify'])
})

test('preparation does not add inspections to the backend planning reads', async () => {
  const { backend, calls } = setup()
  await prepareTransfer(backend, input)
  assert.deepEqual(calls, ['plan'])
})

test('both independent inspections start before either resolves', async () => {
  const { backend, plan } = setup()
  const started: string[] = []
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  backend.inspect = async ({ wallet }) => {
    started.push(wallet)
    await pending
    return wallet === 'source' ? plan.diagnostics.source : plan.diagnostics.destination
  }
  const result = inspectTransfer(backend, input)
  assert.deepEqual(started, ['source', 'destination'])
  release()
  await result
})

for (const side of ['source', 'destination'] as const) {
  for (const verdict of ['ineligible', 'unknown'] as const) {
    test(`${side} ${verdict} remains diagnostic and prevents preparation`, async () => {
      const { backend, plan, calls } = setup()
      plan.diagnostics[side].verdict = verdict
      plan.diagnostics[side].reasons = [{ code: 'AttestationExpired', message: 'Proof expired.' }]
      assert.equal((await inspectTransfer(backend, input))[side].verdict, verdict)
      await assert.rejects(prepareTransfer(backend, input), (error: unknown) => {
        assert.ok(error instanceof DeskError)
        assert.equal(error.code, verdict === 'unknown' ? 'ReadUnverifiable' : 'SimulationFailed')
        assert.match(error.message, /AttestationExpired: Proof expired/)
        return true
      })
      assert.ok(!calls.includes('verify'))
    })
  }

  const inconsistent: [string, (value: EligibilitySnapshot) => void][] = [
    ['cluster', (value) => { value.read.cluster = 'devnet' }],
    ['backend', (value) => { value.backend = 'mpl3643' }],
    ['mint', (value) => { value.mint = 'other-mint' }],
    ['subject', (value) => { value.wallet = 'other-wallet' }],
    ['RPC URL', (value) => { value.read.rpcUrl = 'http://127.0.0.1:9999' }],
    ['commitment', (value) => { value.read.commitment = 'finalized' }],
  ]
  for (const [field, mutate] of inconsistent) {
    test(`rejects inconsistent ${side} ${field} in inspection and preparation`, async () => {
      const { backend, plan } = setup()
      mutate(plan.diagnostics[side])
      await assert.rejects(inspectTransfer(backend, input), { code: 'ReadUnverifiable' })
      await assert.rejects(prepareTransfer(backend, input), { code: 'ReadUnverifiable' })
    })
  }
}

test('allows independent slots and additional legitimate required signers', async () => {
  const { backend, plan } = setup()
  plan.diagnostics.destination.read.slot++
  plan.requiredSigners = ['fee-payer', 'source', 'authority']
  assert.equal(await prepareTransfer(backend, input), plan)
})

for (const requiredSigners of [[], ['other-wallet']]) {
  test(`rejects missing source signer: ${JSON.stringify(requiredSigners)}`, async () => {
    const { backend, plan, calls } = setup()
    plan.requiredSigners = requiredSigners
    await assert.rejects(prepareTransfer(backend, input), { code: 'ReadUnverifiable' })
    await assert.rejects(verifyPreparedTransfer(backend, plan, 'localnet', 'signature'), { code: 'ReadUnverifiable' })
    assert.ok(!calls.includes('verify'))
  })
}

test('unsupported transfer capability stops before planning', async () => {
  const { backend, calls } = setup()
  backend.capabilities = () => []
  await assert.rejects(prepareTransfer(backend, input), { code: 'UnsupportedCapability' })
  assert.deepEqual(calls, [])
})

test('empty transaction fails closed', async () => {
  const { backend, plan } = setup()
  plan.transaction = ' '
  await assert.rejects(prepareTransfer(backend, input), { code: 'SimulationFailed' })
})

test('plan backend mismatch prevents planning result and verification', async () => {
  const { backend, plan, calls } = setup()
  plan.backend = 'mpl3643'
  await assert.rejects(prepareTransfer(backend, input), { code: 'ReadUnverifiable' })
  await assert.rejects(verifyPreparedTransfer(backend, plan, 'localnet', 'signature'), { code: 'ReadUnverifiable' })
  assert.ok(!calls.includes('verify'))
})

test('wrong verification cluster and incoherent plan diagnostics prevent delegation', async () => {
  const { backend, plan, calls } = setup()
  await assert.rejects(verifyPreparedTransfer(backend, plan, 'devnet', 'signature'), { code: 'ReadUnverifiable' })
  plan.diagnostics.destination.mint = 'another-mint'
  await assert.rejects(verifyPreparedTransfer(backend, plan, 'localnet', 'signature'), { code: 'ReadUnverifiable' })
  plan.diagnostics.destination.mint = input.mint
  plan.diagnostics.destination.read.commitment = 'processed'
  await assert.rejects(verifyPreparedTransfer(backend, plan, 'localnet', 'signature'), { code: 'ReadUnverifiable' })
  assert.deepEqual(calls, [])
})

for (const signature of [undefined, '', '  ']) {
  test(`no usable signature yields unknown without delegating: ${JSON.stringify(signature)}`, async () => {
    const { backend, plan, calls } = setup()
    backend.verifyOutcome = async () => { throw new Error('Must not delegate without a signature') }
    const evidence = await verifyPreparedTransfer(backend, plan, 'localnet', signature)
    assert.equal(evidence.status, 'unknown')
    assert.equal(evidence.error?.code, 'ConfirmationUnknown')
    assert.deepEqual(calls, [])
  })
}

for (const status of ['unknown', 'failed', 'confirmed'] as const) {
  test(`preserves delegated ${status} evidence without claiming a signature-plan binding`, async () => {
    const { backend, plan, evidence } = setup()
    evidence.status = status
    assert.equal(await verifyPreparedTransfer(backend, plan, 'localnet', 'signature'), evidence)
  })
}

test('verification is not gated by a later unknown eligibility verdict', async () => {
  const { backend, plan, evidence } = setup()
  plan.diagnostics.source.verdict = 'unknown'
  assert.equal(await verifyPreparedTransfer(backend, plan, 'localnet', 'signature'), evidence)
})

test('opaque transaction changes are delegated, never labeled authenticated', async () => {
  const { backend, plan } = setup()
  plan.transaction = 'Y2hhbmdlZA=='
  const evidence: OperationEvidence = { status: 'unknown', logs: [] }
  backend.verifyOutcome = async (request: VerifyInput) => {
    assert.equal(request.plan, plan)
    return evidence
  }
  assert.equal(await verifyPreparedTransfer(backend, plan, 'localnet', 'signature'), evidence)
})

for (const stage of ['inspect', 'planTransfer', 'verifyOutcome'] as const) {
  test(`propagates ${stage} errors without manufacturing execution evidence`, async () => {
    const { backend, plan } = setup()
    const failure = new Error(`${stage} unavailable`)
    backend[stage] = async () => { throw failure }
    const operation = stage === 'inspect' ? inspectTransfer(backend, input)
      : stage === 'planTransfer' ? prepareTransfer(backend, input)
        : verifyPreparedTransfer(backend, plan, 'localnet', 'signature')
    await assert.rejects(operation, (error: unknown) => error === failure)
  })
}
