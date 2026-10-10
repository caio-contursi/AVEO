import { onchainErrorFromCode, ONCHAIN_ERRORS } from '@aveo/contracts'
import { getBase58Encoder, isAddress, isSignature, type Address, type Signature } from '@solana/kit'
import { z } from 'zod'
import type { ApiContext } from '../../api/context'
import { IX_DISCRIMINATOR, SYSTEM_PROGRAM_ID } from '../../api/constants'
import { decodeEligibilityPayload } from '../../api/codecs'
import { bytesToHex, type Deployment } from '../../config/deployment'

export const MAX_DEMO_EVIDENCE_BYTES = 512 * 1024
// Mirror scripts/localnet-safety.ts without importing its Node-only path helpers.
// Both public generation and browser consumption must reject public networks.
const PUBLIC_GENESIS_HASHES = new Set([
  'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
])
export const DEMO_SCENES = [
  { id: 'reuse', stageIds: ['shared-proof-X', 'successful-transfers'] },
  { id: 'policies', stageIds: ['policy-differences-Y-B-Z'] },
  { id: 'outside', stageIds: ['external-with-extra-accounts', 'external-expired-proof-rejected'] },
  { id: 'invalidation', stageIds: ['close-X-proofs', 'rejected-transfers-unchanged-balances'] },
  { id: 'impact', stageIds: ['scan-grouping'] },
  { id: 'renewal', stageIds: ['issue-renewal-proof', 'signed-batched-rebind', 'fresh-readback', 'renewed-successful-transfers'] },
] as const

const addressSchema = z.string().max(44).refine(isAddress).transform((value) => value as Address)
const slotSchema = z.number().int().nonnegative().safe()
const amountSchema = z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine((value) => BigInt(value) <= 18446744073709551615n)
const addressList = z.array(addressSchema).min(1).max(8).refine((values) => new Set(values).size === values.length)
export const publicDemoEvidenceSchema = z.object({
  signature: z.string().max(88).refine(isSignature).optional(),
  slot: slotSchema.optional(),
  status: z.enum(['confirmed', 'failed']).optional(),
  hookCode: z.enum(ONCHAIN_ERRORS).optional(),
  wallet: addressSchema.optional(),
  source: addressSchema.optional(),
  destination: addressSchema.optional(),
  sharedProof: addressSchema.optional(),
  closedProof: addressSchema.optional(),
  proof: addressSchema.optional(),
  renewal: addressSchema.optional(),
  mints: addressList.optional(),
  affectedMints: addressList.optional(),
  slots: z.array(slotSchema).min(1).max(8).optional(),
  asset: z.enum(['alfa', 'beta']).optional(),
  accepted: z.boolean().optional(),
  before: z.array(amountSchema).length(2).optional(),
  after: z.array(amountSchema).length(2).optional(),
  incidentType: z.literal('PROOF_CLOSED').optional(),
  verdicts: z.array(z.enum(['eligible', 'ineligible', 'unknown'])).min(1).max(8).optional(),
  expiry: slotSchema.optional(),
  clockUnix: slotSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (Object.keys(value).length === 0 || (value.signature && value.slot === undefined && !(value.renewal && value.slots && value.verdicts))
    || (value.status === 'failed' && (!value.signature || !value.hookCode))
    || (value.signature && value.hookCode && value.status !== 'failed')
    || (value.signature && value.status === 'confirmed' && value.hookCode)) {
    ctx.addIssue({ code: 'custom', message: 'Incomplete public evidence' })
  }
})
export const PUBLIC_DEMO_EVIDENCE_KEYS = Object.freeze(Object.keys(publicDemoEvidenceSchema.shape))
export type PublicEvidenceSubset = z.infer<typeof publicDemoEvidenceSchema>

const idSchema = z.string().regex(/^[a-zA-Z0-9-]{1,100}$/)
const stageSchema = z.object({ id: idSchema, status: z.literal('PASS'), evidence: z.array(publicDemoEvidenceSchema).min(1).max(64) }).strict()
const transferStageIds = new Set(['successful-transfers', 'renewed-successful-transfers', 'external-with-extra-accounts', 'external-expired-proof-rejected', 'rejected-transfers-unchanged-balances', 'policy-differences-Y-B-Z'])
const sceneSchema = z.object({ id: z.enum(['reuse', 'policies', 'outside', 'invalidation', 'impact', 'renewal']), stages: z.array(stageSchema).min(1).max(4) }).strict()
const bundleSchema = z.object({
  version: z.literal(1), scope: z.literal('localnet-synthetic'),
  genesisHash: z.string().max(44).refine((value): boolean => isAddress(value)), programId: addressSchema,
  deploymentGeneratedAt: z.iso.datetime(), completedAt: z.iso.datetime(),
  assets: z.array(z.object({ id: idSchema, mint: addressSchema }).strict()).length(2),
  wallets: z.array(z.object({ id: idSchema, address: addressSchema }).strict()).min(4).max(8),
  scenes: z.array(sceneSchema).length(6),
}).strict()
export type DemoEvidence = z.infer<typeof bundleSchema>
export type DemoScene = DemoEvidence['scenes'][number]

export class DemoEvidenceError extends Error {
  constructor(readonly kind: 'invalid' | 'network' | 'not-found', message: string) {
    super(message)
    this.name = 'DemoEvidenceError'
  }
}

function invalid(): never { throw new DemoEvidenceError('invalid', 'Demo evidence is invalid or does not match this local deployment') }

/** Pure selection: stage evidence stays historical, even after renewal restores eligibility. */
export function mapDemoScenes(stages: readonly { id: string; status: string; evidence: unknown[] }[]): DemoScene[] {
  return DEMO_SCENES.map((scene) => ({
    id: scene.id,
    stages: scene.stageIds.map((id) => {
      const matches = stages.filter((stage) => stage.id === id)
      if (matches.length !== 1) return invalid()
      const parsed = stageSchema.safeParse(matches[0])
      if (!parsed.success) return invalid()
      return parsed.data
    }),
  }))
}

export function parseDemoEvidence(value: unknown, deployment: Deployment): DemoEvidence {
  const parsed = bundleSchema.safeParse(value)
  if (!parsed.success || deployment.cluster !== 'localnet') return invalid()
  const bundle = parsed.data
  if (PUBLIC_GENESIS_HASHES.has(bundle.genesisHash)) return invalid()
  if (new TextEncoder().encode(JSON.stringify(bundle)).byteLength > MAX_DEMO_EVIDENCE_BYTES) return invalid()
  if (bundle.programId !== deployment.programs.aveoHook || bundle.deploymentGeneratedAt !== deployment.generatedAt
    || Date.parse(bundle.completedAt) < Date.parse(bundle.deploymentGeneratedAt)) return invalid()
  const unique = (items: string[]) => new Set(items).size === items.length
  if (!unique(bundle.assets.map((a) => a.id)) || !unique(bundle.assets.map((a) => a.mint))
    || !unique(bundle.wallets.map((w) => w.id)) || !unique(bundle.wallets.map((w) => w.address))) return invalid()
  if (!['alfa', 'beta'].every((id) => bundle.assets.some((a) => a.id === id))
    || !['X', 'Y', 'Z', 'treasury'].every((id) => bundle.wallets.some((w) => w.id === id))) return invalid()
  if (bundle.assets.some((asset) => !deployment.assets.some((a) => a.id === asset.id && a.mint === asset.mint))
    || bundle.wallets.some((wallet) => !deployment.wallets.some((w) => w.id === wallet.id && w.address === wallet.address))) return invalid()
  const mints = bundle.assets.map((a) => a.mint)
  const wallets = bundle.wallets.map((w) => w.address)
  const x = bundle.wallets.find((w) => w.id === 'X')!.address
  const signatures = new Set<string>()
  const bothMints = (values?: Address[]) => values?.length === 2 && mints.every((mint) => values.includes(mint))
  for (const [index, scene] of bundle.scenes.entries()) {
    const required = DEMO_SCENES[index]!
    if (scene.id !== required.id || scene.stages.length !== required.stageIds.length) return invalid()
    for (const [stageIndex, stage] of scene.stages.entries()) {
      if (stage.id !== required.stageIds[stageIndex]) return invalid()
      for (const e of stage.evidence) {
        if ([e.wallet, e.source, e.destination].some((w) => w && !wallets.includes(w))
          || [...(e.mints ?? []), ...(e.affectedMints ?? [])].some((m) => !mints.includes(m))) return invalid()
        if (e.signature && stage.id !== 'fresh-readback') {
          if (e.slot === undefined) return invalid()
          if (signatures.has(e.signature)) return invalid()
          signatures.add(e.signature)
        }
      }
      const has = (check: (e: PublicEvidenceSubset) => boolean) => stage.evidence.some(check)
      const transaction = (failed = false, code?: PublicEvidenceSubset['hookCode']) => has((e) => !!e.signature && e.slot !== undefined
        && (failed ? e.status === 'failed' && e.hookCode === code : e.status !== 'failed' && !e.hookCode))
      const transfer = (accepted: boolean, code?: PublicEvidenceSubset['hookCode'], asset?: string, source?: Address, destination?: Address) => has((e) => e.accepted === accepted && !!e.asset
        && (!asset || e.asset === asset) && (!source || e.source === source) && (!destination || e.destination === destination)
        && !!e.source && !!e.destination && e.source !== e.destination && !!e.before && !!e.after && e.slot !== undefined
        && (accepted ? BigInt(e.before[0]!) > BigInt(e.after[0]!) && BigInt(e.before[1]!) < BigInt(e.after[1]!)
          && BigInt(e.before[0]!) - BigInt(e.after[0]!) === BigInt(e.after[1]!) - BigInt(e.before[1]!)
          : e.hookCode === code && e.before.every((amount, i) => amount === e.after![i])))
      let valid = false
      const treasury = bundle.wallets.find((w) => w.id === 'treasury')!.address
      const bothAssets = (accepted: boolean, code?: PublicEvidenceSubset['hookCode'], bothDirections = false) =>
        bundle.assets.every((a) => transfer(accepted, code, a.id, treasury, x) && (!bothDirections || transfer(accepted, code, a.id, x, treasury)))
      switch (stage.id) {
        case 'shared-proof-X': valid = has((e) => e.wallet === x && !!e.sharedProof && bothMints(e.mints) && e.slots?.length === 2); break
        case 'successful-transfers': valid = transaction() && bothAssets(true); break
        case 'renewed-successful-transfers': valid = transaction() && bothAssets(true, undefined, true); break
        case 'external-with-extra-accounts': valid = transaction() && transfer(true); break
        case 'policy-differences-Y-B-Z': valid = transaction() && transaction(true, 'ProviderPairNotAllowed') && transaction(true, 'RequiredFactMissing')
          && ['Y', 'Z'].every((id) => {
            const wallet = bundle.wallets.find((w) => w.id === id)!.address
            return transfer(true, undefined, 'alfa', treasury, wallet)
              && transfer(false, id === 'Y' ? 'ProviderPairNotAllowed' : 'RequiredFactMissing', 'beta', treasury, wallet)
          }); break
        case 'external-expired-proof-rejected': valid = transaction(true, 'AttestationExpired') && transfer(false, 'AttestationExpired'); break
        // Authorized close and later external expiry are deliberately separate events.
        case 'close-X-proofs': valid = transaction() && has((e) => !!e.closedProof); break
        case 'rejected-transfers-unchanged-balances': valid = transaction(true, 'AttestationMissingOrClosed') && bothAssets(false, 'AttestationMissingOrClosed', true); break
        case 'scan-grouping': valid = has((e) => e.incidentType === 'PROOF_CLOSED' && !!e.proof && bothMints(e.affectedMints)); break
        case 'issue-renewal-proof': valid = transaction() && has((e) => e.wallet === x && !!e.renewal); break
        case 'signed-batched-rebind': valid = transaction(); break
        case 'fresh-readback': valid = has((e) => !!e.renewal && e.slots?.length === 2 && e.verdicts?.length === 2 && e.verdicts.every((v) => v === 'eligible')); break
      }
      if (!valid) return invalid()
      if (transferStageIds.has(stage.id)) {
        for (const [i, e] of stage.evidence.entries()) {
          if (e.accepted !== undefined) {
            const tx = stage.evidence[i - 1]
            if (!tx?.signature || tx.slot === undefined || e.slot === undefined || e.slot < tx.slot
              || e.accepted !== (tx.status !== 'failed') || e.hookCode !== tx.hookCode) return invalid()
          }
          if (e.signature && stage.evidence[i + 1]?.accepted === undefined) return invalid()
        }
      }
    }
  }
  const shared = bundle.scenes[0]!.stages[0]!.evidence.find((e) => e.sharedProof)!.sharedProof
  const closed = bundle.scenes[3]!.stages[0]!.evidence.filter((e) => e.closedProof).map((e) => e.closedProof)
  const grouped = bundle.scenes[4]!.stages[0]!.evidence.find((e) => e.incidentType)
  const renewalStages = bundle.scenes[5]!.stages
  const renewal = renewalStages[0]!.evidence.find((e) => e.renewal)!.renewal
  const rebind = renewalStages[1]!.evidence.find((e) => e.signature)!
  if (!closed.includes(shared) || grouped?.proof !== shared || renewal === shared
    || !renewalStages[2]!.evidence.some((e) => e.renewal === renewal && e.signature === rebind.signature
      && e.slots?.every((slot) => slot >= rebind.slot!))) return invalid()
  return bundle
}

async function boundedRead<T>(read: (signal: AbortSignal) => Promise<T>, parent: AbortSignal | undefined, timeoutMs: number): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancel: (() => void) | undefined
  try {
    return await Promise.race([
      new Promise<never>((_resolve, reject) => {
        cancel = () => { controller.abort(); reject(new Error('Read unavailable')) }
        timer = setTimeout(cancel, Math.max(1, timeoutMs))
        parent?.addEventListener('abort', cancel, { once: true })
        if (parent?.aborted) cancel()
      }),
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new Error('Read unavailable')
        return read(controller.signal)
      }),
    ])
  } finally {
    clearTimeout(timer)
    if (cancel) parent?.removeEventListener('abort', cancel)
  }
}

export async function fetchDemoEvidence(url: string, deployment: Deployment, signal?: AbortSignal): Promise<DemoEvidence> {
  try { return await boundedRead((boundedSignal) => readDemoEvidence(url, deployment, boundedSignal), signal, 10_000) }
  catch (error) {
    if (error instanceof DemoEvidenceError) throw error
    throw new DemoEvidenceError('network', 'Demo evidence could not be fetched')
  }
}

async function readDemoEvidence(url: string, deployment: Deployment, signal: AbortSignal): Promise<DemoEvidence> {
  let response: Response
  try { response = await fetch(url, { cache: 'no-store', signal, redirect: 'error', mode: 'same-origin' }) }
  catch { throw new DemoEvidenceError('network', 'Demo evidence could not be fetched') }
  if (response.status === 404) throw new DemoEvidenceError('not-found', 'Demo evidence is unavailable')
  if (!response.ok) throw new DemoEvidenceError('network', 'Demo evidence could not be fetched')
  if (!response.headers.get('content-type')?.includes('application/json') || !response.body) return invalid()
  const length = response.headers.get('content-length')
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_DEMO_EVIDENCE_BYTES)) return invalid()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value: chunk } = await reader.read()
      if (done) break
      size += chunk.byteLength
      if (size > MAX_DEMO_EVIDENCE_BYTES) { await reader.cancel(); return invalid() }
      chunks.push(chunk)
    }
  } catch (error) {
    if (error instanceof DemoEvidenceError) throw error
    throw new DemoEvidenceError('network', 'Demo evidence could not be fetched')
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { return invalid() }
  return parseDemoEvidence(value, deployment)
}

export interface DemoTransactionResult { signature: string; status: 'verified' | 'unavailable' | 'mismatch'; slot?: number }
export type DemoReadContext = Pick<ApiContext, 'cluster' | 'programId' | 'deployment' | 'commitment'> & {
  rpc: Pick<ApiContext['rpc'], 'getGenesisHash' | 'getTransaction'>
  readTimeoutMs?: number
  totalTimeoutMs?: number
}

function hookOutcome(logs: readonly string[], programId: Address, code?: PublicEvidenceSubset['hookCode']): boolean {
  const stack: string[] = []
  for (const line of logs) {
    const invoke = /^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[(\d+)\]$/.exec(line)
    if (invoke) {
      if (Number(invoke[2]) !== stack.length + 1) return false
      stack.push(invoke[1]!)
      continue
    }
    const terminal = /^Program ([1-9A-HJ-NP-Za-km-z]+) (success|failed: .+)$/.exec(line)
    if (!terminal) continue
    if (stack.pop() !== terminal[1]) return false
    if (terminal[1] !== programId) continue
    if (!code && terminal[2] === 'success') return true
    const failure = /^failed: custom program error: 0x([0-9a-f]+)$/i.exec(terminal[2]!)
    if (code && failure && onchainErrorFromCode(Number.parseInt(failure[1]!, 16)) === code) return true
  }
  return false
}

/** Confirms ledger outcomes only, never historical account layouts or attestation claims. */
export async function verifyDemoTransactions(ctx: DemoReadContext, input: DemoEvidence, signal?: AbortSignal): Promise<DemoTransactionResult[]> {
  const bundle = parseDemoEvidence(input, ctx.deployment)
  const records = bundle.scenes.flatMap((scene) => scene.stages.flatMap((stage) => stage.id === 'fresh-readback' ? [] : stage.evidence.flatMap((e, index) => e.signature ? [{ stage, e, detail: stage.evidence[index + 1] }] : [])))
  const unavailable = () => records.map(({ e }) => ({ signature: e.signature!, status: 'unavailable' as const }))
  if (ctx.cluster !== 'localnet' || ctx.programId !== bundle.programId || signal?.aborted) return unavailable()
  const limit = (value: number | undefined, fallback: number, max: number) => value !== undefined && Number.isFinite(value) ? Math.max(1, Math.min(value, max)) : fallback
  const readTimeout = limit(ctx.readTimeoutMs, 10_000, 10_000)
  const deadline = Date.now() + limit(ctx.totalTimeoutMs, 60_000, 120_000)
  const read = <T>(callback: (signal: AbortSignal) => Promise<T>) => boundedRead(callback, signal, Math.min(readTimeout, deadline - Date.now()))
  try { if (await read((abortSignal) => ctx.rpc.getGenesisHash().send({ abortSignal })) !== bundle.genesisHash) return unavailable() }
  catch { return unavailable() }
  const results: DemoTransactionResult[] = []
  for (const { stage, e, detail } of records) {
    const result: DemoTransactionResult = { signature: e.signature!, status: 'unavailable' }
    results.push(result)
    if (signal?.aborted || Date.now() >= deadline) continue
    try {
      const tx = await read((abortSignal) => ctx.rpc.getTransaction(e.signature as Signature, { encoding: 'json', commitment: ctx.commitment === 'finalized' ? 'finalized' : 'confirmed', maxSupportedTransactionVersion: 0 }).send({ abortSignal }))
      if (!tx?.meta || !tx.meta.logMessages) continue
      const meta = tx.meta
      result.status = 'mismatch'
      if (tx.slot !== BigInt(e.slot!) || tx.transaction.signatures[0] !== e.signature) continue
      const accounts = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])]
      const transferStage = transferStageIds.has(stage.id)
      const mint = detail?.asset ? bundle.assets.find((a) => a.id === detail.asset)?.mint : undefined
      if (transferStage && (!mint || detail?.accepted !== (e.status !== 'failed') || detail?.hookCode !== e.hookCode)) continue
      if (stage.id !== 'close-X-proofs' && stage.id !== 'issue-renewal-proof'
        && (!accounts.includes(bundle.programId) || !(mint ? accounts.includes(mint) : bundle.assets.some((a) => accounts.includes(a.mint))))) continue
      if ([e.wallet, e.source].some((a) => a && !accounts.includes(a))) continue
      let transferInstructionIndex = -1
      if (transferStage) {
        if (!meta.preTokenBalances || !meta.postTokenBalances) { result.status = 'unavailable'; continue }
        // Token owners come from ledger token balances; ATAs, rather than destination
        // wallets, are the accounts passed to TransferChecked.
        transferInstructionIndex = tx.transaction.message.instructions.findIndex((ix) => {
          if (accounts[ix.programIdIndex] !== ctx.deployment.programs.token2022 || accounts[ix.accounts[1]!] !== mint) return false
          const data = getBase58Encoder().encode(ix.data)
          const asset = bundle.assets.find((a) => a.mint === mint)
          const decimals = ctx.deployment.assets.find((a) => a.id === asset?.id)?.decimals
          if (data.length !== 10 || data[0] !== 12 || data[9] !== decimals) return false
          const sourceIndex = ix.accounts[0]
          const destinationIndex = ix.accounts[2]
          const balance = (values: typeof meta.preTokenBalances | undefined, accountIndex: number | undefined, owner: Address | undefined) =>
            values?.find((b) => b.accountIndex === accountIndex && b.mint === mint && b.owner === owner)?.uiTokenAmount.amount
          const before = [balance(meta.preTokenBalances, sourceIndex, detail?.source), balance(meta.preTokenBalances, destinationIndex, detail?.destination)]
          const after = [balance(meta.postTokenBalances, sourceIndex, detail?.source), balance(meta.postTokenBalances, destinationIndex, detail?.destination)]
          if (!detail?.before || !detail.after || before.some((amount, i) => amount !== detail.before![i]) || after.some((amount, i) => amount !== detail.after![i])) return false
          let amount = 0n
          for (let i = 8; i >= 1; i--) amount = (amount << 8n) + BigInt(data[i]!)
          return amount > 0n && (e.status === 'failed' || amount === BigInt(detail.before[0]!) - BigInt(detail.after[0]!))
        })
        if (transferInstructionIndex < 0) continue
      }
      if (stage.id === 'signed-batched-rebind') {
        const subject = bundle.wallets.find((w) => w.id === 'X')!.address
        const renewal = bundle.scenes[5]!.stages[0]!.evidence.find((item) => item.renewal)!.renewal!
        const signed = (index: number) => index >= 0 && index < Number(tx.transaction.message.header.numRequiredSignatures)
        if (!bundle.assets.every((asset) => tx.transaction.message.instructions.some((ix) => {
          const data = getBase58Encoder().encode(ix.data)
          return accounts[ix.programIdIndex] === bundle.programId && data.length === IX_DISCRIMINATOR.setBinding.length
            && IX_DISCRIMINATOR.setBinding.every((byte, i) => byte === data[i])
            && accounts[ix.accounts[0]!] === subject && signed(ix.accounts[0]!)
            && accounts[ix.accounts[1]!] === asset.mint && accounts[ix.accounts[6]!] === renewal
        }))) continue
      }
      const logs = tx.meta.logMessages
      if (stage.id === 'close-X-proofs' || stage.id === 'issue-renewal-proof') {
        const closing = stage.id === 'close-X-proofs'
        const proof = closing ? detail?.closedProof : detail?.renewal
        if (!proof || !accounts.includes(proof) || !accounts.includes(ctx.deployment.programs.sas)
          || !hookOutcome(logs, ctx.deployment.programs.sas)) continue
        const instruction = tx.transaction.message.instructions.some((ix) => {
          if (accounts[ix.programIdIndex] !== ctx.deployment.programs.sas || ix.accounts.length !== (closing ? 7 : 6)) return false
          const data = getBase58Encoder().encode(ix.data)
          // Pinned sas-lib 1.0.10 generated instructions: create=6, close=7;
          // payer, authority, credential, [schema], attestation, system program.
          if (data[0] !== (closing ? 7 : 6) || accounts[ix.accounts[closing ? 3 : 4]!] !== proof
            || accounts[ix.accounts[5]!] !== SYSTEM_PROGRAM_ID
            || (closing && accounts[ix.accounts[6]!] !== ctx.deployment.programs.sas)) return false
          const signerCount = Number(tx.transaction.message.header.numRequiredSignatures)
          if ([ix.accounts[0], ix.accounts[1]].some((index) => index === undefined || index < 0 || index >= signerCount)) return false
          const verifier = ctx.deployment.verifiers.find((v) => v.authority === accounts[ix.accounts[1]!] && v.credential === accounts[ix.accounts[2]!])
          if (!verifier) return false
          if (closing) return data.length === 1
          if (data.length < 45 || accounts[ix.accounts[3]!] !== verifier.schema) return false
          const size = ((data[33]! | (data[34]! << 8) | (data[35]! << 16) | (data[36]! << 24)) >>> 0)
          if (data.length !== 45 + size) return false
          // Authenticate the submitted bytes, not a later historical account read.
          const payload = decodeEligibilityPayload(data.slice(37, 37 + size))
          return payload.subjectWallet === bundle.wallets.find((w) => w.id === 'X')!.address
            && bytesToHex(payload.proofDomain) === ctx.deployment.proofDomain && payload.kycPass && payload.accreditedPass
        })
        if (!instruction) continue
      }
      if (e.status === 'failed') {
        const err = meta.err
        if (!err || typeof err !== 'object' || !('InstructionError' in err)) continue
        const [index, reason] = err.InstructionError
        if (Number(index) !== transferInstructionIndex || !reason || typeof reason !== 'object' || !('Custom' in reason)
          || onchainErrorFromCode(Number(reason.Custom)) !== e.hookCode || !hookOutcome(logs, bundle.programId, e.hookCode)) continue
      } else if (meta.err !== null || ((transferStage || stage.id === 'signed-batched-rebind') && !hookOutcome(logs, bundle.programId))) continue
      result.status = 'verified'
      result.slot = Number(tx.slot)
    } catch { /* Provider errors and missing history are intentionally unavailable. */ }
  }
  return results
}
