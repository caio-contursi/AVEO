// Observe an interrupted synthetic intent; never sign, broadcast or release its gate.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isSignature } from '@solana/kit'
import { AVEO_HOOK_PROGRAM_ID } from '../src/api/constants'
import type { ApiContext } from '../src/api/context'
import { verifySubmissionMessage } from '../src/api/submission-proof'
import { parseDeployment } from '../src/config/deployment'
import { SubmissionIntentStore } from '../src/features/operations/submission-intent'
import { openLocalIntentStorage } from './local-intent-storage'
import { bounded, recoverySubjects, validateLocalEndpoints } from './local-recovery-check'
import { readPublicReceiptFile } from './local-recovery-resume'
import { localIntentRead } from './local-intent-read'
import { requireLocalGenesis } from './localnet-safety'

const failure = () => new Error('Local intent inspection could not verify the original operation; the persistent gate has not been released.')
function check(value: unknown): asserts value { if (!value) throw failure() }

export interface IntentInspection {
  version: 1
  scope: 'localnet-synthetic'
  status: 'confirmed' | 'failed' | 'unknown' | 'blocked' | 'empty' | 'context-mismatch' | 'invalid-signature'
  evidenceOnly: true
  gateReleased: false
  signingCalls: 0
  submissionCalls: 0
  signature?: string
  slot?: number
}

/** Read-only transport and storage: this command cannot settle another process's intent. */
export async function inspectLocalIntent(input: {
  ctx: ApiContext
  store: SubmissionIntentStore
  expectedGenesis: string
  signature?: string
  read?: typeof localIntentRead
}): Promise<IntentInspection> {
  const base = { version: 1 as const, scope: 'localnet-synthetic' as const, evidenceOnly: true as const,
    gateReleased: false as const, signingCalls: 0 as const, submissionCalls: 0 as const }
  try {
    return await bounded(async (signal) => {
      const { store } = input
      const ctx = { ...input.ctx, deployment: structuredClone(input.ctx.deployment) }
      validateLocalEndpoints(ctx.cluster, ctx.rpcUrl, 'ws://127.0.0.1:8900')
      requireLocalGenesis(input.expectedGenesis, input.expectedGenesis)
      check(ctx.commitment === 'confirmed' && ctx.programId === AVEO_HOOK_PROGRAM_ID)
      const { x } = recoverySubjects(ctx.deployment)
      store.refreshFromStorage()
      const snapshot = store.getSnapshot()
      if (snapshot.error) return { ...base, status: 'blocked' }
      const intent = snapshot.intent
      if (!intent) return { ...base, status: 'empty' }
      if (intent.phase !== 'wallet-invoked' || !intent.messageFingerprint || intent.kind !== 'transfer' || intent.signer !== x.address) {
        return { ...base, status: 'blocked' }
      }
      const signature = input.signature ?? intent.signature
      if (typeof signature !== 'string' || signature.length > 88 || !isSignature(signature) ||
        (intent.signature !== undefined && signature !== intent.signature)) return { ...base, status: 'invalid-signature' }
      if (!await store.matchesContext(ctx, intent)) return { ...base, status: 'context-mismatch' }
      const read = input.read ?? localIntentRead
      const pin = async () => {
        check(!signal.aborted)
        const genesis = await read(ctx.rpcUrl, 'getGenesisHash', [])
        check(typeof genesis === 'string')
        requireLocalGenesis(genesis, input.expectedGenesis)
        check(!signal.aborted)
      }
      await pin()
      // Deliberately expose just one transaction-read method, not the SDK send API.
      const readCtx = { ...ctx, rpc: {
        getTransaction: (candidate: string, config: unknown) => ({ send: () =>
          read(ctx.rpcUrl, 'getTransaction', [candidate, config]) }),
      } as unknown as ApiContext['rpc'] }
      const proof = await verifySubmissionMessage(readCtx, signature, intent.messageFingerprint)
      await pin()
      store.refreshFromStorage()
      check(!store.getSnapshot().error && JSON.stringify(store.getSnapshot().intent) === JSON.stringify(intent))
      return proof ? { ...base, status: proof.status, signature, slot: proof.slot } : { ...base, status: 'unknown', signature }
    }, 35_000)
  } catch { return { ...base, status: 'blocked' } }
}

export async function main(): Promise<void> {
  check(process.argv.length === 3 || process.argv.length === 4)
  const file = process.argv[2]
  const rpcUrl = process.env.AVEO_RPC_URL ?? 'http://127.0.0.1:8899'
  validateLocalEndpoints(process.env.AVEO_CLUSTER ?? 'localnet', rpcUrl, process.env.AVEO_WS_URL ?? 'ws://127.0.0.1:8900')
  const expectedGenesis = process.env.AVEO_LOCAL_GENESIS_HASH
  check(expectedGenesis)
  requireLocalGenesis(expectedGenesis, expectedGenesis)
  // The adapter validates an existing mode-private external /tmp file before any RPC.
  const storage = openLocalIntentStorage(file)
  const store = new SubmissionIntentStore({ getItem: storage.getItem, setItem: () => { throw failure() } },
    async (operation) => { await operation() })
  const deployment = parseDeployment(readPublicReceiptFile(path.join(path.dirname(file), 'deployment.json')),
    { cluster: 'localnet', programId: AVEO_HOOK_PROGRAM_ID })
  const ctx = { cluster: 'localnet', rpcUrl, commitment: 'confirmed', programId: AVEO_HOOK_PROGRAM_ID,
    deployment, rpc: {} } as ApiContext
  const result = await inspectLocalIntent({ ctx, store, expectedGenesis, signature: process.argv[3] })
  console.log(JSON.stringify(result))
  // A verified rejection is not a successful transfer. Unknown/empty never imply settlement.
  if (result.status !== 'confirmed') process.exitCode = result.status === 'failed' ? 1 : 2
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error(failure().message); process.exitCode = 2 })
}
