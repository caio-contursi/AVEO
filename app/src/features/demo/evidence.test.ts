import { getAddressDecoder, getBase58Decoder, signature } from '@solana/kit'
import { ONCHAIN_ERRORS } from '@aveo/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AVEO_HOOK_PROGRAM_ID, IX_DISCRIMINATOR, SAS_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '../../api/constants'
import { encodeEligibilityPayload } from '../../api/codecs'
import type { Deployment } from '../../config/deployment'
import { DEMO_SCENES, DemoEvidenceError, MAX_DEMO_EVIDENCE_BYTES, fetchDemoEvidence, mapDemoScenes, parseDemoEvidence, publicDemoEvidenceSchema, verifyDemoTransactions, type DemoEvidence, type DemoReadContext, type PublicEvidenceSubset } from './evidence'

const addr = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n))
const sig = (n: number) => signature(getBase58Decoder().decode(new Uint8Array(64).fill(n)))
const deployment: Deployment = {
  version: 1, cluster: 'localnet', generatedAt: '2026-10-10T12:00:00.000Z',
  programs: { aveoHook: AVEO_HOOK_PROGRAM_ID, sas: SAS_PROGRAM_ID, token2022: TOKEN_2022_PROGRAM_ID },
  proofDomain: 'ab'.repeat(32), issuer: addr(1), verifiers: [{ id: 'A', label: 'A', authority: addr(7), credential: addr(22), schema: addr(23) }],
  assets: ['alfa', 'beta'].map((id, i) => ({ id, label: id, symbol: id, decimals: 0, mint: addr(i + 2) })),
  wallets: ['X', 'Y', 'Z', 'treasury'].map((id, i) => ({ id, label: id, address: addr(i + 4), role: id === 'treasury' ? 'treasury' : 'investor' })),
}

function fixture(): DemoEvidence {
  let sequence = 0
  const tx = (hookCode?: PublicEvidenceSubset['hookCode']): PublicEvidenceSubset => ({ signature: sig(++sequence), slot: sequence, ...(hookCode ? { status: 'failed', hookCode } : {}) })
  const transfer = (hookCode?: PublicEvidenceSubset['hookCode'], asset: 'alfa' | 'beta' = 'alfa', source = addr(7), destination = addr(4)): PublicEvidenceSubset[] => [tx(hookCode), {
    asset, source, destination, accepted: !hookCode,
    before: ['10', '0'], after: hookCode ? ['10', '0'] : ['9', '1'], slot: 50, ...(hookCode ? { hookCode } : {}),
  }]
  const both = (code?: PublicEvidenceSubset['hookCode'], directions = false) => (['alfa', 'beta'] as const).flatMap((asset) => [
    ...transfer(code, asset), ...(directions ? transfer(code, asset, addr(4), addr(7)) : []),
  ])
  let rebind: PublicEvidenceSubset
  const stages = DEMO_SCENES.flatMap((scene) => scene.stageIds.map((id) => {
    let evidence: PublicEvidenceSubset[]
    switch (id) {
      case 'shared-proof-X': evidence = [{ wallet: addr(4), sharedProof: addr(20), mints: [addr(2), addr(3)], slots: [1, 1] }]; break
      case 'successful-transfers': evidence = both(); break
      case 'external-with-extra-accounts': evidence = transfer(); break
      case 'renewed-successful-transfers': evidence = both(undefined, true); break
      case 'policy-differences-Y-B-Z': evidence = [...transfer(undefined, 'alfa', addr(7), addr(5)), ...transfer('ProviderPairNotAllowed', 'beta', addr(7), addr(5)), ...transfer(undefined, 'alfa', addr(7), addr(6)), ...transfer('RequiredFactMissing', 'beta', addr(7), addr(6))]; break
      case 'external-expired-proof-rejected': evidence = transfer('AttestationExpired'); break
      case 'close-X-proofs': evidence = [tx(), { closedProof: addr(20) }]; break
      case 'rejected-transfers-unchanged-balances': evidence = both('AttestationMissingOrClosed', true); break
      case 'scan-grouping': evidence = [{ incidentType: 'PROOF_CLOSED', proof: addr(20), affectedMints: [addr(2), addr(3)] }]; break
      case 'issue-renewal-proof': evidence = [tx(), { wallet: addr(4), renewal: addr(21) }]; break
      case 'signed-batched-rebind': rebind = tx(); evidence = [rebind]; break
      case 'fresh-readback': evidence = [{ signature: rebind!.signature, renewal: addr(21), slots: [50, 50], verdicts: ['eligible', 'eligible'] }]; break
    }
    return { id, status: 'PASS', evidence: evidence! }
  }))
  return {
    version: 1, scope: 'localnet-synthetic', genesisHash: addr(30), programId: AVEO_HOOK_PROGRAM_ID,
    deploymentGeneratedAt: deployment.generatedAt, completedAt: '2026-10-10T13:00:00.000Z',
    assets: deployment.assets.map(({ id, mint }) => ({ id, mint })), wallets: deployment.wallets.map(({ id, address }) => ({ id, address })),
    scenes: mapDemoScenes(stages),
  }
}

function reads(bundle = fixture()) {
  const getGenesisHash = vi.fn(() => ({ send: vi.fn(async () => bundle.genesisHash) }))
  const getTransaction = vi.fn((signature: string) => ({ send: vi.fn(async () => {
    const stage = bundle.scenes.flatMap((s) => s.stages).find((stage) => stage.evidence.some((e) => e.signature === signature))!
    const index = stage.evidence.findIndex((e) => e.signature === signature)
    const evidence = stage.evidence[index]!
    const detail = stage.evidence[index + 1]
    const code = (6000 + ONCHAIN_ERRORS.indexOf(evidence.hookCode!)).toString(16)
    const mint = detail?.asset === 'beta' ? addr(3) : addr(2)
    const createData = new Uint8Array(120)
    createData[0] = 6; createData[33] = 75
    createData.set(encodeEligibilityPayload({ subjectWallet: addr(4), proofDomain: new Uint8Array(32).fill(171), kycPass: true, accreditedPass: true }), 37)
    return {
      slot: BigInt(evidence.slot!), transaction: { signatures: [signature], message: {
        header: { numRequiredSignatures: 8 },
        accountKeys: [bundle.programId, SAS_PROGRAM_ID, ...bundle.assets.map((a) => a.mint), ...bundle.wallets.map((w) => w.address), addr(20), addr(21), TOKEN_2022_PROGRAM_ID, addr(40), addr(41), addr(22), addr(23), SYSTEM_PROGRAM_ID, addr(24)],
        instructions: stage.id === 'close-X-proofs' ? [{ programIdIndex: 1, accounts: [7, 7, 13, 8, 16, 15, 1], data: getBase58Decoder().decode(new Uint8Array([7])) }]
          : stage.id === 'issue-renewal-proof' ? [{ programIdIndex: 1, accounts: [7, 7, 13, 14, 9, 15], data: getBase58Decoder().decode(createData) }]
          : stage.id === 'signed-batched-rebind' ? [2, 3].map((mintIndex) => ({ programIdIndex: 0, accounts: [4, mintIndex, 2, 3, 2, 3, 9], data: getBase58Decoder().decode(IX_DISCRIMINATOR.setBinding) }))
          : [{ programIdIndex: 10, accounts: [11, detail?.asset === 'beta' ? 3 : 2, 12, 7], data: getBase58Decoder().decode(new Uint8Array([12, 1, 0, 0, 0, 0, 0, 0, 0, 0])) }],
      } },
      meta: { err: evidence.status === 'failed' ? { InstructionError: [0, { Custom: Number.parseInt(code, 16) }] } : null,
        preTokenBalances: detail?.before?.map((amount, i) => ({ accountIndex: i === 0 ? 11 : 12, mint, owner: i === 0 ? detail.source : detail.destination, uiTokenAmount: { amount } })),
        postTokenBalances: detail?.after?.map((amount, i) => ({ accountIndex: i === 0 ? 11 : 12, mint, owner: i === 0 ? detail.source : detail.destination, uiTokenAmount: { amount } })),
        logMessages: [`Program ${TOKEN_2022_PROGRAM_ID} invoke [1]`, `Program ${bundle.programId} invoke [2]`, evidence.status === 'failed' ? `Program ${bundle.programId} failed: custom program error: 0x${code}` : `Program ${bundle.programId} success`, `Program ${TOKEN_2022_PROGRAM_ID} success`, `Program ${SAS_PROGRAM_ID} invoke [1]`, `Program ${SAS_PROGRAM_ID} success`] },
    }
  }) }))
  const ctx = { deployment, programId: bundle.programId, cluster: 'localnet', commitment: 'confirmed', rpc: { getGenesisHash, getTransaction } } as unknown as DemoReadContext
  return { ctx, getGenesisHash, getTransaction }
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('public judge evidence', () => {
  it('preserves the exact six historical scenes and rebind reference', () => {
    const bundle = fixture()
    expect(parseDemoEvidence(bundle, deployment)).toEqual(bundle)
    expect(bundle.scenes.map((s) => s.id)).toEqual(['reuse', 'policies', 'outside', 'invalidation', 'impact', 'renewal'])
  })

  it.each([
    (b: DemoEvidence) => { Object.assign(b, { secretKey: [1] }) },
    (b: DemoEvidence) => { Object.assign(b.assets[0]!, { secretKey: [1] }) },
    (b: DemoEvidence) => { Object.assign(b.scenes[0]!.stages[0]!.evidence[0]!, { seed: 'hidden' }) },
    (b: DemoEvidence) => { b.scenes.reverse() },
    (b: DemoEvidence) => { b.scenes.pop() },
    (b: DemoEvidence) => { b.scenes[0]!.stages.reverse() },
    (b: DemoEvidence) => { b.scenes[0]!.stages[0]!.evidence = [{}] },
    (b: DemoEvidence) => { b.assets[1]!.mint = b.assets[0]!.mint },
    (b: DemoEvidence) => { b.wallets[1]!.address = b.wallets[0]!.address },
    (b: DemoEvidence) => { b.programId = addr(31) },
    (b: DemoEvidence) => { b.deploymentGeneratedAt = '2026-10-09T12:00:00.000Z' },
    (b: DemoEvidence) => { b.completedAt = '2026-10-09T12:00:00.000Z' },
    (b: DemoEvidence) => { b.scenes[4]!.stages[0]!.evidence[0]!.affectedMints = [addr(31), addr(3)] },
    (b: DemoEvidence) => { b.scenes[3]!.stages[0]!.evidence[1]!.closedProof = addr(31) },
    (b: DemoEvidence) => { b.scenes[5]!.stages[2]!.evidence[0]!.slots = [0, 0] },
    (b: DemoEvidence) => { b.scenes[0]!.stages[1]!.evidence[0]!.slot = undefined },
    (b: DemoEvidence) => { b.scenes[0]!.stages[1]!.evidence[1]!.before = ['18446744073709551616', '0'] },
    (b: DemoEvidence) => { b.scenes[2]!.stages[1]!.evidence[0]!.hookCode = 'RequiredFactMissing' },
    (b: DemoEvidence) => { Object.assign(b.scenes[0]!.stages[0]!, { status: 'FAIL' }) },
    (b: DemoEvidence) => { b.scenes[0]!.stages[1]!.evidence.splice(2, 2) },
    (b: DemoEvidence) => { b.scenes[3]!.stages[1]!.evidence.splice(2, 2) },
    (b: DemoEvidence) => { b.scenes[5]!.stages[3]!.evidence.splice(4, 4) },
  ])('rejects malformed, private or mismatched records (%#)', (mutate) => {
    const bundle = fixture(); mutate(bundle)
    expect(() => parseDemoEvidence(bundle, deployment)).toThrow(DemoEvidenceError)
  })

  it('rejects devnet and arbitrary evidence keys', () => {
    expect(() => parseDemoEvidence(fixture(), { ...deployment, cluster: 'devnet' })).toThrow(DemoEvidenceError)
    expect(publicDemoEvidenceSchema.safeParse({ signature: sig(1), slot: 1, privateKey: 'never' }).success).toBe(false)
  })

  it.each([
    'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
  ])('rejects public genesis %s despite a forged localnet scope', (genesisHash) => {
    expect(() => parseDemoEvidence({ ...fixture(), genesisHash }, deployment)).toThrow(DemoEvidenceError)
  })

  it('maps only required stages without mutating the report and rejects duplicates', () => {
    const stages = fixture().scenes.flatMap((s) => s.stages)
    const snapshot = structuredClone(stages)
    expect(mapDemoScenes([...stages, { id: 'irrelevant', status: 'FAIL', evidence: [] }])).toHaveLength(6)
    expect(stages).toEqual(snapshot)
    expect(() => mapDemoScenes([...stages, stages[0]!])).toThrow(DemoEvidenceError)
  })
})

describe('read-only ledger recheck', () => {
  it('pins genesis before lookups and verifies exact signature slots and hook outcomes', async () => {
    const bundle = fixture(); const mock = reads(bundle)
    const result = await verifyDemoTransactions(mock.ctx, bundle)
    expect(result.every((r) => r.status === 'verified')).toBe(true)
    expect(result[0]!.slot).toBe(1)
    expect(mock.getGenesisHash.mock.invocationCallOrder[0]).toBeLessThan(mock.getTransaction.mock.invocationCallOrder[0]!)
    expect(mock.getTransaction).toHaveBeenCalledWith(sig(1), { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
    expect(mock.getTransaction).toHaveBeenCalledTimes(19)
  })

  it('does not query transactions on a different genesis or aborted read', async () => {
    const bundle = fixture(); const mock = reads(bundle)
    mock.getGenesisHash.mockImplementation(() => ({ send: vi.fn(async () => addr(31)) }))
    expect((await verifyDemoTransactions(mock.ctx, bundle)).every((r) => r.status === 'unavailable')).toBe(true)
    const controller = new AbortController(); controller.abort()
    await verifyDemoTransactions(mock.ctx, bundle, controller.signal)
    expect(mock.getTransaction).not.toHaveBeenCalled()
  })

  it.each(['slot', 'signature', 'mint', 'program', 'subject', 'generic-failure', 'wrong-reason', 'hook-success', 'instruction-index', 'quoted-log', 'balance-owner', 'balance-amount', 'decimals'] as const)('detects %s mismatches', async (change) => {
    const bundle = fixture(); const mock = reads(bundle)
    const original = mock.getTransaction.getMockImplementation()!
    mock.getTransaction.mockImplementation((signature) => ({ send: vi.fn(async () => {
      const tx = await original(signature).send()
      if (change === 'slot') tx.slot += 1n
      if (change === 'signature') tx.transaction.signatures = [sig(99)]
      if (change === 'mint') tx.transaction.message.accountKeys = tx.transaction.message.accountKeys.filter((a) => a !== addr(2))
      if (change === 'program') tx.transaction.message.accountKeys = tx.transaction.message.accountKeys.filter((a) => a !== bundle.programId)
      if (change === 'subject') tx.transaction.message.accountKeys = tx.transaction.message.accountKeys.filter((a) => a !== addr(4))
      if (change === 'generic-failure') tx.meta.logMessages = ['generic failure']
      if (change === 'wrong-reason') tx.meta.logMessages = [`Program ${bundle.programId} invoke [2]`, `Program ${bundle.programId} failed: custom program error: 0x1770`]
      if (change === 'hook-success') tx.meta.logMessages = []
      if (change === 'instruction-index' && tx.meta.err) tx.meta.err.InstructionError[0] = 3
      if (change === 'quoted-log') tx.meta.logMessages = tx.meta.logMessages.map((line) => `Program log: ${line}`)
      if (change === 'balance-owner' && tx.meta.preTokenBalances) tx.meta.preTokenBalances[0]!.owner = addr(99)
      if (change === 'balance-amount' && tx.meta.postTokenBalances) tx.meta.postTokenBalances[0]!.uiTokenAmount.amount = '999'
      if (change === 'decimals') tx.transaction.message.instructions[0]!.data = getBase58Decoder().decode(new Uint8Array([12, 1, 0, 0, 0, 0, 0, 0, 0, 9]))
      return tx
    }) }))
    const result = await verifyDemoTransactions(mock.ctx, bundle)
    const index = change === 'generic-failure' || change === 'wrong-reason' || change === 'instruction-index' ? 3 : 0
    expect(result[index]!.status).toBe('mismatch')
  })

  it('returns unavailable on missing history or provider failure without leaking errors or retrying', async () => {
    const bundle = fixture(); const mock = reads(bundle)
    mock.getTransaction.mockImplementation(() => ({ send: vi.fn(async () => { throw new Error('SECRET RPC URL') }) }))
    const result = await verifyDemoTransactions(mock.ctx, bundle)
    expect(result.every((r) => r.status === 'unavailable')).toBe(true)
    expect(JSON.stringify(result)).not.toContain('SECRET')
    expect(mock.getTransaction).toHaveBeenCalledTimes(result.length)
  })

  it('verifies an ATA transfer without the destination owner in message accounts', async () => {
    const bundle = fixture(); const mock = reads(bundle)
    const original = mock.getTransaction.getMockImplementation()!
    mock.getTransaction.mockImplementation((signature) => ({ send: vi.fn(async () => {
      const tx = await original(signature).send()
      tx.transaction.message.accountKeys[4] = addr(99)
      return tx
    }) }))
    expect((await verifyDemoTransactions(mock.ctx, bundle))[0]!.status).toBe('verified')
  })

  it('includes resolved address-table accounts when checking versioned transfers', async () => {
    const bundle = fixture(); const mock = reads(bundle)
    const original = mock.getTransaction.getMockImplementation()!
    mock.getTransaction.mockImplementation((signature) => ({ send: vi.fn(async () => {
      const tx = await original(signature).send()
      Object.assign(tx.meta, { loadedAddresses: { writable: tx.transaction.message.accountKeys.splice(10), readonly: [] } })
      return tx
    }) }))
    expect((await verifyDemoTransactions(mock.ctx, bundle))[0]!.status).toBe('verified')
  })

  it.each(['unsigned', 'wrong-proof', 'wrong-instruction'] as const)('rejects %s rebind evidence', async (change) => {
    const bundle = fixture(); const mock = reads(bundle)
    const original = mock.getTransaction.getMockImplementation()!
    mock.getTransaction.mockImplementation((signature) => ({ send: vi.fn(async () => {
      const tx = await original(signature).send()
      if (change === 'unsigned') tx.transaction.message.header.numRequiredSignatures = 1
      if (change === 'wrong-proof') tx.transaction.message.accountKeys[9] = addr(99)
      if (change === 'wrong-instruction') tx.transaction.message.instructions[0]!.data = getBase58Decoder().decode(IX_DISCRIMINATOR.updatePolicy)
      return tx
    }) }))
    expect((await verifyDemoTransactions(mock.ctx, bundle))[14]!.status).toBe('mismatch')
  })

  it.each(['wrong-instruction', 'wrong-proof', 'unsigned', 'wrong-credential', 'wrong-schema', 'wrong-subject'] as const)('rejects %s SAS operation evidence', async (change) => {
    const bundle = fixture(); const mock = reads(bundle)
    const original = mock.getTransaction.getMockImplementation()!
    mock.getTransaction.mockImplementation((signature) => ({ send: vi.fn(async () => {
      const tx = await original(signature).send()
      const ix = tx.transaction.message.instructions[0]!
      if (change === 'wrong-instruction') ix.data = getBase58Decoder().decode(new Uint8Array([5]))
      if (change === 'wrong-proof') { tx.transaction.message.accountKeys[8] = addr(98); tx.transaction.message.accountKeys[9] = addr(99) }
      if (change === 'unsigned') tx.transaction.message.header.numRequiredSignatures = 1
      if (change === 'wrong-credential') tx.transaction.message.accountKeys[13] = addr(99)
      if (change === 'wrong-schema') tx.transaction.message.accountKeys[14] = addr(99)
      if (change === 'wrong-subject' && ix.programIdIndex === 1 && ix.accounts.length === 6) {
        const bytes = new Uint8Array(120)
        bytes[0] = 6; bytes[33] = 75
        bytes.set(encodeEligibilityPayload({ subjectWallet: addr(99), proofDomain: new Uint8Array(32).fill(171), kycPass: true, accreditedPass: true }), 37)
        ix.data = getBase58Decoder().decode(bytes)
      }
      return tx
    }) }))
    const result = await verifyDemoTransactions(mock.ctx, bundle)
    expect(result[13]!.status).toBe('mismatch')
    if (change !== 'wrong-schema' && change !== 'wrong-subject') expect(result[8]!.status).toBe('mismatch')
  })

  it('treats absent transactions as unavailable', async () => {
    const bundle = fixture(); const mock = reads(bundle)
    const rpc = { ...mock.ctx.rpc, getTransaction: vi.fn(() => ({ send: vi.fn(async () => null) })) } as unknown as DemoReadContext['rpc']
    expect((await verifyDemoTransactions({ ...mock.ctx, rpc }, bundle)).every((r) => r.status === 'unavailable')).toBe(true)
  })

  it('enforces individual and total deadlines even when an injected reader ignores cancellation', async () => {
    vi.useFakeTimers()
    const bundle = fixture(); const mock = reads(bundle)
    mock.getTransaction.mockImplementation(() => ({ send: vi.fn(() => new Promise<never>(() => {})) }))
    const pending = verifyDemoTransactions({ ...mock.ctx, readTimeoutMs: 5, totalTimeoutMs: 12 }, bundle)
    await vi.advanceTimersByTimeAsync(20)
    expect((await pending).every((r) => r.status === 'unavailable')).toBe(true)
    expect(mock.getTransaction).toHaveBeenCalledTimes(3)
  })

  it('bounds genesis reads before starting any transaction lookup', async () => {
    vi.useFakeTimers()
    const bundle = fixture(); const mock = reads(bundle)
    mock.getGenesisHash.mockImplementation(() => ({ send: vi.fn(() => new Promise<never>(() => {})) }))
    const pending = verifyDemoTransactions({ ...mock.ctx, readTimeoutMs: 5 }, bundle)
    await vi.advanceTimersByTimeAsync(10)
    expect((await pending).every((r) => r.status === 'unavailable')).toBe(true)
    expect(mock.getTransaction).not.toHaveBeenCalled()
  })
})

describe('bounded evidence fetch', () => {
  it('fetches JSON with same-origin mode, cancellation and no redirects', async () => {
    const bundle = fixture(); const fetcher = vi.fn(async () => new Response(JSON.stringify(bundle), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetcher)
    const signal = new AbortController().signal
    expect(await fetchDemoEvidence('/demo-evidence.json', deployment, signal)).toEqual(bundle)
    expect(fetcher).toHaveBeenCalledWith('/demo-evidence.json', { cache: 'no-store', mode: 'same-origin', redirect: 'error', signal: expect.any(AbortSignal) })
  })

  it.each(['length', 'stream', 'html', 'json'] as const)('rejects %s violations', async (kind) => {
    const body = kind === 'stream' ? ' '.repeat(MAX_DEMO_EVIDENCE_BYTES + 1) : 'bad JSON'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: {
      'content-type': kind === 'html' ? 'text/html' : 'application/json',
      ...(kind === 'length' ? { 'content-length': String(MAX_DEMO_EVIDENCE_BYTES + 1) } : {}),
    } })))
    await expect(fetchDemoEvidence('/demo-evidence.json', deployment)).rejects.toMatchObject({ kind: 'invalid' })
  })

  it('sanitizes network errors and reports absent bundles', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('PRIVATE RPC URL') }))
    await expect(fetchDemoEvidence('/demo-evidence.json', deployment)).rejects.toThrow('Demo evidence could not be fetched')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
    await expect(fetchDemoEvidence('/demo-evidence.json', deployment)).rejects.toMatchObject({ kind: 'not-found' })
  })

  it('bounds a stalled fetch and sanitizes its deadline error', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(() => new Promise<never>(() => {})))
    const assertion = expect(fetchDemoEvidence('/demo-evidence.json', deployment)).rejects.toMatchObject({ kind: 'network', message: 'Demo evidence could not be fetched' })
    await vi.advanceTimersByTimeAsync(10_001)
    await assertion
  })
})
