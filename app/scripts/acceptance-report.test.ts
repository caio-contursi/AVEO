import { getAddressDecoder, getBase58Decoder } from '@solana/kit'
import { describe, expect, it } from 'vitest'
import { AcceptanceReportBuilder } from './acceptance-report'

const NOW = '2026-10-09T12:00:00.000Z'
const address = getAddressDecoder().decode(new Uint8Array(32).fill(7))
const signature = getBase58Decoder().decode(new Uint8Array(64).fill(8))

function builder(stages = ['shared-proof-X', 'successful-transfers']) {
  const result = new AcceptanceReportBuilder(NOW)
  result.acceptLine(`ACCEPTANCE_RUN ${JSON.stringify({ stages })}`)
  return result
}

describe('public acceptance receipt', () => {
  it('retains public run binding at localnet preconditions while stripping private fields', () => {
    const report = builder(['localnet-preconditions', 'shared-proof-X'])
    const metadata = { genesisHash: address, deploymentGeneratedAt: NOW }
    report.acceptLine(`EVIDENCE ${JSON.stringify({ ...metadata, rpcUrl: 'private', secretKey: [1, 2, 3] })}`)
    report.acceptLine('PASS localnet-preconditions')
    report.acceptLine('PASS shared-proof-X')
    const result = report.finish(0, NOW)
    expect(result).toMatchObject({ version: 1, scope: 'localnet-synthetic', status: 'PASS', issues: [] })
    expect(result.stages[0]!.evidence).toEqual([metadata])
    expect(result.stages[1]!.evidence).toEqual([])
    expect(JSON.stringify(result)).not.toMatch(/private|secretKey/)
  })

  it('keeps run binding fields optional for existing report consumers', () => {
    const report = builder(['localnet-preconditions'])
    report.acceptLine(`EVIDENCE ${JSON.stringify({ slot: 1 })}`)
    report.acceptLine('PASS localnet-preconditions')
    expect(report.finish(0, NOW)).toMatchObject({ status: 'PASS', stages: [{ evidence: [{ slot: 1 }] }] })
  })

  it.each([
    { genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' },
    { genesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' },
    { genesisHash: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY' },
    { genesisHash: 'not-a-genesis' }, { genesisHash: '1'.repeat(31) },
    { genesisHash: 'z'.repeat(44) }, { genesisHash: '1'.repeat(45) },
    { genesisHash: 1 }, { genesisHash: null },
    { deploymentGeneratedAt: '2026-10-10' }, { deploymentGeneratedAt: 'not-a-date' },
    { deploymentGeneratedAt: '2026-02-30T12:00:00.000Z' },
    { deploymentGeneratedAt: 1 }, { deploymentGeneratedAt: null },
  ])('rejects malformed or public-network run binding without retaining it: %j', (metadata) => {
    const report = builder(['localnet-preconditions'])
    report.acceptLine(`EVIDENCE ${JSON.stringify({ slot: 1, ...metadata })}`)
    report.acceptLine('PASS localnet-preconditions')
    expect(report.finish(0, NOW)).toMatchObject({
      status: 'FAIL', issues: ['Invalid public evidence record'], stages: [{ evidence: [] }],
    })
  })

  it('retains typed schema/signer observations without accepting malformed authority evidence', () => {
    const report = builder(['schema'])
    report.acceptLine(`EVIDENCE ${JSON.stringify({ schemaPaused: true, authorizedSigners: [address] })}`)
    report.acceptLine('PASS schema')
    expect(report.finish(0, NOW).stages[0]!.evidence).toEqual([{ schemaPaused: true, authorizedSigners: [address] }])
    for (const evidence of [{ schemaPaused: 1 }, { authorizedSigners: ['not-an-address'] }]) {
      const invalid = builder(['schema'])
      invalid.acceptLine(`EVIDENCE ${JSON.stringify(evidence)}`)
      invalid.acceptLine('PASS schema')
      expect(invalid.finish(0, NOW).status).toBe('FAIL')
    }
  })
  it('retains only typed synthetic KYC facts without claiming complete T04 coverage', () => {
    const stages = ['false-kyc-proof-bound', 'false-kyc-transfers-rejected', 'false-kyc-original-bindings-restored']
    const report = builder(stages)
    const facts = { requiredFact: 'kyc', kycPass: false, accreditedPass: true, hookCode: 'RequiredFactMissing' }
    report.acceptLine(`EVIDENCE ${JSON.stringify({ ...facts, identity: 'private', providerResponse: 'secret' })}`)
    for (const stage of stages) report.acceptLine(`PASS ${stage}`)
    const result = report.finish(0, NOW)
    expect(result.status).toBe('PASS')
    expect(result.stages[0]!.evidence).toEqual([facts])
    expect(result.matrix.find((item) => item.id === 'T04')?.status).toBe('NOT_RUN')
    expect(JSON.stringify(result)).not.toMatch(/private|secret/)
  })

  it.each([{ requiredFact: 'unknown' }, { kycPass: 'false' }, { accreditedPass: 1 }])(
    'rejects malformed synthetic fact evidence: %j', (facts) => {
      const report = builder(['one'])
      report.acceptLine(`EVIDENCE ${JSON.stringify(facts)}`)
      report.acceptLine('PASS one')
      expect(report.finish(0, NOW).status).toBe('FAIL')
    },
  )
  it.each([
    ['T15', ['persistence-initial-save', 'persistence-process-restart', 'persistence-repeated-scan']],
    ['T12', ['delegate-approved-owner-transfer', 'delegate-expired-owner-rejected', 'delegate-approval-revoked']],
    ['T13', ['direct-hook-execute-rejected', 'unsigned-policy-update-rejected', 'unsigned-binding-rejected']],
    ['T16', ['boundary-zero-amount', 'boundary-excessive-amount', 'boundary-max-u64-rejected', 'boundary-exact-balance', 'boundary-same-owner-distinct-accounts', 'boundary-fixtures-restored']],
    ['T14', ['fault-localnet-preconditions', 'rpc-account-timeout', 'rpc-unavailable-incident', 'rpc-stale-read-keeps-open', 'confirmation-timeout-keeps-open', 'read-only-recheck-recovers-signature', 'fresh-complete-readback-resolves']],
  ])('requires every stage before passing %s', (id, stages) => {
    const report = builder(stages)
    for (const stage of stages.slice(0, -1)) report.acceptLine(`PASS ${stage}`)
    expect(report.finish(0, NOW).matrix.find((entry) => entry.id === id)?.status).toBe('NOT_RUN')
    report.acceptLine(`PASS ${stages.at(-1)}`)
    expect(report.finish(0, NOW).matrix.find((entry) => entry.id === id)?.status).toBe('PASS')
    const failed = builder(stages)
    failed.acceptLine(`FAIL ${stages[0]}`)
    for (const stage of stages.slice(1)) failed.acceptLine(`NOT_RUN ${stage}`)
    expect(failed.finish(1, NOW).matrix.find((entry) => entry.id === id)?.status).toBe('FAIL')
  })
  it('marks only T15 PASS when only persistence stages ran', () => {
    const stages = ['persistence-initial-save', 'persistence-process-restart', 'persistence-repeated-scan']
    const report = builder(stages)
    for (const stage of stages) report.acceptLine(`PASS ${stage}`)
    const result = report.finish(0, NOW)
    expect(result.matrix.filter((entry) => entry.status === 'PASS').map((entry) => entry.id)).toEqual(['T15'])
    expect(result.matrix.filter((entry) => entry.id !== 'T15').every((entry) => entry.status === 'NOT_RUN')).toBe(true)
  })
  it('retains validated public allowance and fault counters, not transport details', () => {
    const report = builder(['one'])
    const publicFields = { delegatedAllowanceBefore: '10', delegatedAllowanceAfter: '9', rpcReadCalls: 4, sendCalls: 0, abortedRequests: 1,
      faultTransport: 'http-loopback', validatorError: 'TokenInsufficientFunds', amount: '18446744073709551615' }
    report.acceptLine(`EVIDENCE ${JSON.stringify({ ...publicFields, rpcUrl: 'secret', request: 'secret' })}`)
    report.acceptLine('PASS one')
    expect(report.finish(0, NOW).stages[0]?.evidence).toEqual([publicFields])
  })
  it('requires successful, missing-extra and expired-proof external checks before passing T11', () => {
    const stages = ['external-with-extra-accounts', 'external-without-extra-accounts', 'external-expired-proof-rejected']
    const report = builder(stages)
    report.acceptLine(`PASS ${stages[0]}`)
    report.acceptLine(`PASS ${stages[1]}`)
    expect(report.finish(0, NOW).matrix.find((entry) => entry.id === 'T11')?.status).toBe('NOT_RUN')
    report.acceptLine(`PASS ${stages[2]}`)
    expect(report.finish(0, NOW).matrix.find((entry) => entry.id === 'T11')?.status).toBe('PASS')
    const failed = builder(stages)
    failed.acceptLine(`PASS ${stages[0]}`)
    failed.acceptLine(`FAIL ${stages[1]}`)
    failed.acceptLine(`NOT_RUN ${stages[2]}`)
    expect(failed.finish(1, NOW).matrix.find((entry) => entry.id === 'T11')?.status).toBe('FAIL')
  })
  it('ties public evidence to stages and keeps untouched cases NOT_RUN', () => {
    const report = builder()
    report.acceptLine(`EVIDENCE ${JSON.stringify({ sharedProof: address, wallet: address, slots: [1, 2] })}`)
    report.acceptLine('PASS shared-proof-X')
    report.acceptLine(`EVIDENCE ${JSON.stringify({ signature, slot: 3, before: ['20', '10'], after: ['19', '11'] })}`)
    report.acceptLine('PASS successful-transfers')
    report.acceptLine('PASS demo-check (2/2)')
    const result = report.finish(0, NOW)
    expect(result.status).toBe('PASS')
    expect(result.stages[0]!.evidence[0]).toMatchObject({ sharedProof: address })
    expect(result.stages[1]!.evidence[0]).toMatchObject({ signature, slot: 3 })
    expect(result.matrix.find((entry) => entry.id === 'T01')?.status).toBe('PASS')
    expect(result.matrix.find((entry) => entry.id === 'T13')).toMatchObject({ status: 'NOT_RUN' })
    expect(result.matrix).toHaveLength(17)
  })

  it('strips secrets, RPC URLs and nested unapproved fields', () => {
    const report = builder(['one'])
    report.acceptLine(`EVIDENCE ${JSON.stringify({ signature, slot: 1, secretKey: [1, 2, 3], rpcUrl: 'https://private.test/?apiKey=secret', nested: { privateKey: 'secret' } })}`)
    report.acceptLine('PASS one')
    const result = report.finish(0, NOW)
    expect(result.status).toBe('PASS')
    expect(result.stages[0]!.evidence).toEqual([{ signature, slot: 1 }])
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(JSON.stringify(result)).not.toContain('private.test')
  })

  it.each([
    { signature: 'not-a-signature' },
    { wallet: 'https://private.test/?apiKey=secret' },
    { slot: -1 },
    { before: ['secret', '1'] },
    { hookCode: 'fake-success' },
    { secretKey: [1, 2, 3] },
    { delegatedAllowanceBefore: '-1' },
    { delegatedAllowanceAfter: 9 },
    { rpcReadCalls: 1.5 },
    { sendCalls: -1 },
    { abortedRequests: Number.MAX_SAFE_INTEGER + 1 },
    { faultTransport: 'public-rpc' },
    { amount: '18446744073709551616.5' },
    { validatorError: 'anything-failed' },
  ])('fails closed on malformed evidence without storing it (%j)', (evidence) => {
    const report = builder(['one'])
    report.acceptLine(`EVIDENCE ${JSON.stringify(evidence)}`)
    report.acceptLine('PASS one')
    const result = report.finish(0, NOW)
    expect(result.status).toBe('FAIL')
    expect(result.issues).toEqual(['Invalid public evidence record'])
    expect(result.stages[0]!.evidence).toEqual([])
  })

  it('records failure and not-run stages without saving failure text', () => {
    const report = builder()
    report.acceptLine('FAIL shared-proof-X: private RPC URL or exception text')
    report.acceptLine('NOT_RUN successful-transfers')
    const result = report.finish(1, NOW)
    expect(result.status).toBe('FAIL')
    expect(result.stages.map((stage) => stage.status)).toEqual(['FAIL', 'NOT_RUN'])
    expect(result.matrix.find((entry) => entry.id === 'T01')?.status).toBe('FAIL')
    expect(JSON.stringify(result)).not.toContain('private RPC')
  })

  it('never treats missing metadata or an interrupted run as a success', () => {
    expect(new AcceptanceReportBuilder(NOW).finish(0, NOW).status).toBe('FAIL')
    const report = builder()
    report.acceptLine('PASS shared-proof-X')
    expect(report.finish(null, NOW).status).toBe('FAIL')
    expect(report.finish(0, NOW).stages[1]?.status).toBe('NOT_RUN')
  })

  it('rejects duplicate metadata and out-of-order results', () => {
    const report = builder(['one', 'two'])
    report.acceptLine('ACCEPTANCE_RUN {"stages":["one"]}')
    report.acceptLine('PASS two')
    report.acceptLine('PASS one')
    report.acceptLine('PASS two')
    expect(report.finish(0, NOW)).toMatchObject({ status: 'FAIL', issues: ['Invalid or duplicate runner metadata', 'Unexpected acceptance stage order'] })
  })

  it('rejects duplicate stage declarations and malformed JSON', () => {
    const report = new AcceptanceReportBuilder(NOW)
    report.acceptLine('ACCEPTANCE_RUN {"stages":["one","one"]}')
    report.acceptLine('EVIDENCE {')
    expect(report.finish(0, NOW).issues).toEqual(['Invalid or duplicate runner metadata', 'Invalid public evidence record'])
  })

  it('does not ignore a failing child exit code after successful stages', () => {
    const report = builder(['one'])
    report.acceptLine('PASS one')
    expect(report.finish(1, NOW).status).toBe('FAIL')
  })
})
