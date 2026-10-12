import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getAddressDecoder } from '@solana/kit'
import { AVEO_HOOK_PROGRAM_ID, SAS_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '../src/api/constants'
import type { Deployment } from '../src/config/deployment'
import { DEMO_ACCEPTANCE_MANIFEST } from './acceptance-stages'
import { buildJudgeEvidence, main, readJudgePublicJson, readJudgeEvidenceResponse, readDevDeploymentResponse } from './judge-evidence'

let directory: string
beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'aveo-judge-evidence-test-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

describe('bounded public evidence serving', () => {
  it('reads a fixed-name regular public JSON file', () => {
    writeFileSync(path.join(directory, 'judge-evidence.json'), '{"version":1}')
    expect(readJudgePublicJson(directory, 'judge-evidence.json')).toEqual({ version: 1 })
  })
  it.each(['wallets.json', '../wallets.json', '/tmp/wallets.json', '', 'other.json'])(
    'rejects the runtime filename %s before reading it', (name) => {
      writeFileSync(path.join(directory, 'wallets.json'), '{"secretKey":[1,2,3]}')
      expect(() => readJudgePublicJson(directory, name as 'judge-evidence.json')).toThrow()
    })
  it('refuses a symlink even when its target is a regular file', () => {
    writeFileSync(path.join(directory, 'wallets.json'), '{"secretKey":[1,2,3]}')
    symlinkSync(path.join(directory, 'wallets.json'), path.join(directory, 'judge-evidence.json'))
    expect(() => readJudgePublicJson(directory, 'judge-evidence.json')).toThrow()
  })
  it.each(['', '{invalid', ' '.repeat(2_000_001)])('rejects empty, malformed or oversized input', (content) => {
    writeFileSync(path.join(directory, 'judge-evidence.json'), content)
    expect(() => readJudgePublicJson(directory, 'judge-evidence.json')).toThrow()
  })
  it('does not serve a renamed private wallet file as public evidence', () => {
    writeFileSync(path.join(directory, 'deployment.json'), JSON.stringify(deployment))
    writeFileSync(path.join(directory, 'judge-evidence.json'), '{"wallets":[{"secretKey":[1,2,3]}]}')
    expect(() => readJudgeEvidenceResponse(directory)).toThrow()
  })
})

const addr = (value: number) => getAddressDecoder().decode(new Uint8Array(32).fill(value))
const deployment: Deployment = {
  version: 1, cluster: 'localnet', generatedAt: '2026-10-10T12:00:00.000Z',
  programs: { aveoHook: AVEO_HOOK_PROGRAM_ID, sas: SAS_PROGRAM_ID, token2022: TOKEN_2022_PROGRAM_ID },
  proofDomain: 'ab'.repeat(32), issuer: addr(1),
  verifiers: [{ id: 'A', label: 'A', authority: addr(2), credential: addr(3), schema: addr(4) }],
  assets: ['alfa', 'beta'].map((id, index) => ({ id, label: id, symbol: id, decimals: 0, mint: addr(5 + index) })),
  wallets: ['X', 'Y', 'Z', 'treasury'].map((id, index) => ({ id, label: id, address: addr(7 + index), role: id === 'treasury' ? 'treasury' : 'investor' })),
}

function completeReport() {
  return { version: 1, scope: 'localnet-synthetic', status: 'PASS', exitCode: 0, issues: [],
    finishedAt: '2026-10-10T13:00:00.000Z',
    stages: DEMO_ACCEPTANCE_MANIFEST.stageIds.map((id, index) => ({ id: String(id), status: 'PASS',
      evidence: index === 0 ? [{ genesisHash: String(addr(30)), deploymentGeneratedAt: deployment.generatedAt }] : [{}] })),
  }
}

describe('full acceptance gate before evidence projection', () => {
  it.each([
    { version: 2 }, { scope: 'devnet' }, { status: 'FAIL' }, { exitCode: 1 },
    { exitCode: null }, { issues: ['Invalid evidence'] }, { stages: [] }, { finishedAt: undefined },
  ])('rejects altered report metadata %j before parsing scene claims', (override) => {
    expect(() => buildJudgeEvidence({ ...completeReport(), ...override }, deployment, addr(30)))
      .toThrow('Judge evidence requires a complete local acceptance report')
  })
  it.each(['missing', 'duplicate', 'reordered', 'failed', 'not-run', 'empty-evidence'])(
    'rejects %s stage acceptance before parsing scene claims', (mutation) => {
      const report = completeReport()
      if (mutation === 'missing') report.stages.pop()
      if (mutation === 'duplicate') report.stages[1]!.id = report.stages[0]!.id
      if (mutation === 'reordered') report.stages.reverse()
      if (mutation === 'failed') report.stages[1]!.status = 'FAIL'
      if (mutation === 'not-run') report.stages[1]!.status = 'NOT_RUN'
      if (mutation === 'empty-evidence') report.stages[1]!.evidence = []
      expect(() => buildJudgeEvidence(report, deployment, addr(30)))
        .toThrow('Judge evidence requires a complete local acceptance report')
    })
  it('refuses public-network genesis and relabelled devnet fixtures', () => {
    expect(() => buildJudgeEvidence(completeReport(), deployment, 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG')).toThrow()
    expect(() => buildJudgeEvidence(completeReport(), { ...deployment, cluster: 'devnet' }, addr(30))).toThrow()
  })
  it.each(['absent', 'wrong-genesis', 'wrong-deployment-date'])('rejects %s original run identity before scene projection', (mutation) => {
    const report = completeReport()
    report.stages[0]!.evidence = mutation === 'absent' ? [] : [{
      genesisHash: mutation === 'wrong-genesis' ? String(addr(31)) : String(addr(30)),
      deploymentGeneratedAt: mutation === 'wrong-deployment-date' ? '2026-10-09T12:00:00.000Z' : deployment.generatedAt,
    }]
    expect(() => buildJudgeEvidence(report, deployment, addr(30))).toThrow('Judge evidence requires a complete local acceptance report')
  })
})

describe('development manifest serving uses the same public-file boundary', () => {
  it('projects a valid manifest without arbitrary unknown fields', () => {
    writeFileSync(path.join(directory, 'deployment.json'), JSON.stringify({ ...deployment, internalNote: 'not public' }))
    expect(JSON.parse(readDevDeploymentResponse(directory))).toEqual(deployment)
  })
  it('refuses secret-like fields even on an otherwise valid manifest', () => {
    writeFileSync(path.join(directory, 'deployment.json'), JSON.stringify({ ...deployment, secretKey: [1, 2, 3] }))
    expect(() => readDevDeploymentResponse(directory)).toThrow()
  })
  it('refuses a deployment symlink to synthetic wallet data', () => {
    writeFileSync(path.join(directory, 'wallets.json'), '{"secretKey":[1,2,3]}')
    symlinkSync(path.join(directory, 'wallets.json'), path.join(directory, 'deployment.json'))
    expect(() => readDevDeploymentResponse(directory)).toThrow()
  })
})

describe('export CLI configuration fails before any RPC or artifact access', () => {
  const base = { AVEO_RPC_URL: 'http://127.0.0.1:19899', AVEO_WS_URL: 'ws://127.0.0.1:19900',
    AVEO_LOCAL_GENESIS_HASH: addr(30), AVEO_DEV_DIR: '/tmp/aveo-test-placeholder' }
  it.each([
    { AVEO_RPC_URL: undefined }, { AVEO_WS_URL: undefined }, { AVEO_LOCAL_GENESIS_HASH: undefined },
    { AVEO_DEV_DIR: undefined }, { AVEO_DEV_DIR: '/' }, { AVEO_DEV_DIR: 'relative' },
    { AVEO_RPC_URL: 'https://api.devnet.solana.com' }, { AVEO_CLUSTER: 'devnet' },
    { AVEO_LOCAL_GENESIS_HASH: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' },
    { AVEO_RPC_URL: 'http://localhost:19899/?key=private' },
  ])('rejects unsafe configuration %j', async (override) => {
    await expect(main({ ...base, ...override })).rejects.toThrow()
  })
})
