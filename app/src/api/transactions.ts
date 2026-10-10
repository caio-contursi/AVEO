// Montagem, simulação, envio e verificação de transações.
// O Desk nunca guarda chave: quem assina é a carteira conectada (ou, só em localnet, uma carteira sintética).
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget'
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getTransferCheckedInstruction,
  resolveExtraAccountMetasForExecute,
} from '@solana-program/token-2022'
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  isTransactionSendingSigner,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signAndSendTransactionMessageWithSigners,
  signTransactionMessageWithSigners,
  getSignatureFromTransaction,
  type Address,
  type Instruction,
  type Signature,
  type TransactionSigner,
} from '@solana/kit'
import { readAccounts, rpcCall } from './accounts'
import { throwIfReadAborted, withReadAbort } from './cancellation'
import type { PolicyArgs } from './codecs'
import type { ApiContext } from './context'
import { reason, type DiagnosticReason } from './diagnostics'
import { failureReason } from './errors'
import { getSetBindingInstruction, getUpdatePolicyInstruction } from './instructions'
import { decodeTokenBalance } from './token-balance'

/** Limite usado só na simulação; a transação real usa o consumo medido com folga. */
const SIMULATION_CU_LIMIT = 1_400_000
const CU_MARGIN = 1.3

export type PlanRequest =
  | {
      kind: 'transfer'
      mint: Address
      sourceOwner: Address
      destinationOwner: Address
      amount: bigint
      decimals: number
    }
  | {
      kind: 'set-binding'
      /** One instruction per mint, same signature. */
      mints: Address[]
      wallet: Address
      credential: Address
      schema: Address
      attestation: Address
    }
  | {
      kind: 'update-policy'
      mint: Address
      authority: Address
      args: PolicyArgs
    }

export function requiredSignerOf(request: PlanRequest): Address {
  switch (request.kind) {
    case 'transfer':
      return request.sourceOwner
    case 'set-binding':
      return request.wallet
    case 'update-policy':
      return request.authority
  }
}

export interface SimulationOutcome {
  ok: boolean
  logs: string[]
  unitsConsumed?: number
  error?: DiagnosticReason
}

export class PlanBlockedError extends Error {
  readonly reason: DiagnosticReason

  constructor(blocked: DiagnosticReason) {
    super(blocked.message)
    this.name = 'PlanBlockedError'
    this.reason = blocked
  }
}

/** A sending wallet or RPC may have broadcast even when its response is lost. */
export class SubmissionUnknownError extends Error {
  constructor(cause: unknown, readonly signature?: Signature) {
    super('Transaction submission is unknown; do not resend.', { cause })
    this.name = 'SubmissionUnknownError'
  }
}

export async function tokenAccountsFor(mint: Address, owners: Address[]): Promise<Address[]> {
  return Promise.all(
    owners.map(async (owner) => (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }))[0]),
  )
}

/** Monta as instruções de um pedido. `signer` é a carteira real ou um NoopSigner (para simular). */
export async function buildInstructions(ctx: ApiContext, request: PlanRequest, signer: TransactionSigner): Promise<Instruction[]> {
  throwIfReadAborted(ctx.readAbortSignal)
  switch (request.kind) {
    case 'set-binding':
      return Promise.all(
        request.mints.map((mint) =>
          getSetBindingInstruction({
            programId: ctx.programId,
            subject: signer,
            mint,
            credential: request.credential,
            schema: request.schema,
            attestation: request.attestation,
          }),
        ),
      )
    case 'update-policy':
      return [await getUpdatePolicyInstruction({ programId: ctx.programId, authority: signer, mint: request.mint, args: request.args })]
    case 'transfer': {
      const [source, destination] = await tokenAccountsFor(request.mint, [request.sourceOwner, request.destinationOwner])
      const { accounts } = await readAccounts(ctx, [source!, destination!])
      if (!accounts[0]) throw new PlanBlockedError(reason('SimulationFailed', 'source token account does not exist', { side: 'source', params: { missing: 'token-account' } }))
      if (!accounts[1]) {
        throw new PlanBlockedError(reason('SimulationFailed', 'destination token account does not exist', { side: 'destination', params: { missing: 'token-account' } }))
      }
      const transfer = getTransferCheckedInstruction({
        source: source!,
        mint: request.mint,
        destination: destination!,
        authority: signer,
        amount: request.amount,
        decimals: request.decimals,
      })
      let extra
      try {
        // The Token-2022 resolver has no signal parameter; adapt only its one read method.
        const rpc: Pick<ApiContext['rpc'], 'getAccountInfo'> = ctx.readAbortSignal ? {
          // Preserve SDK overloads: arguments, response and reactive store pass through unchanged.
          getAccountInfo: ((...args: Parameters<ApiContext['rpc']['getAccountInfo']>) => {
            const [account, config] = args
            const pending = ctx.rpc.getAccountInfo(account, config)
            return { ...pending, send: (options?: Parameters<typeof pending.send>[0]) => withReadAbort(ctx.readAbortSignal, () => pending.send({ ...options, abortSignal: ctx.readAbortSignal })) }
          }) as ApiContext['rpc']['getAccountInfo'],
        } : ctx.rpc
        // Resolução oficial a partir da ExtraAccountMetaList do mint (owner → binding → contas SAS).
        extra = await resolveExtraAccountMetasForExecute({
          rpc,
          transferHookProgramAddress: ctx.programId,
          source: source!,
          mint: request.mint,
          destination: destination!,
          owner: request.sourceOwner,
          amount: request.amount,
        })
      } catch (error) {
        throwIfReadAborted(ctx.readAbortSignal)
        throw new PlanBlockedError(
          reason('MissingExtraAccounts', error instanceof Error ? error.message : String(error), { params: { stage: 'resolve' } }),
        )
      }
      if (extra.length === 0) {
        throw new PlanBlockedError(reason('MissingExtraAccounts', 'mint has no ExtraAccountMetaList', { params: { stage: 'list' } }))
      }
      return [{ ...transfer, accounts: [...transfer.accounts, ...extra] }]
    }
  }
}

async function latestBlockhash(ctx: ApiContext) {
  return withReadAbort(ctx.readAbortSignal, () => rpcCall(async () => (await ctx.rpc.getLatestBlockhash({ commitment: ctx.commitment }).send(
    ctx.readAbortSignal ? { abortSignal: ctx.readAbortSignal } : undefined,
  )).value))
}

/** Simula sem assinatura (sigVerify desligado) e devolve logs, consumo e o erro já traduzido. */
export async function simulate(ctx: ApiContext, instructions: Instruction[], feePayer: Address): Promise<SimulationOutcome> {
  const blockhash = await latestBlockhash(ctx)
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions([getSetComputeUnitLimitInstruction({ units: SIMULATION_CU_LIMIT }), ...instructions], m),
  )
  const wire = getBase64EncodedWireTransaction(compileTransaction(message))
  const { value } = await withReadAbort(ctx.readAbortSignal, () => rpcCall(() =>
    ctx.rpc
      .simulateTransaction(wire, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: ctx.commitment })
      .send(ctx.readAbortSignal ? { abortSignal: ctx.readAbortSignal } : undefined),
  ))
  const logs = [...(value.logs ?? [])]
  const unitsConsumed = value.unitsConsumed !== undefined && value.unitsConsumed !== null ? Number(value.unitsConsumed) : undefined
  if (value.err) return { ok: false, logs, unitsConsumed, error: failureReason(value.err, logs, ctx.programId) }
  return { ok: true, logs, unitsConsumed }
}

/** Transação sem assinatura, em base64, para o UnsignedPlan do contrato. */
export async function unsignedTransaction(ctx: ApiContext, instructions: Instruction[], feePayer: Address): Promise<string> {
  const blockhash = await latestBlockhash(ctx)
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  )
  return getBase64EncodedWireTransaction(compileTransaction(message))
}

export async function planRequest(ctx: ApiContext, request: PlanRequest) {
  throwIfReadAborted(ctx.readAbortSignal)
  const feePayer = requiredSignerOf(request)
  const instructions = await buildInstructions(ctx, request, createNoopSigner(feePayer))
  throwIfReadAborted(ctx.readAbortSignal)
  const simulation = await simulate(ctx, instructions, feePayer)
  throwIfReadAborted(ctx.readAbortSignal)
  const transaction = await unsignedTransaction(ctx, instructions, feePayer)
  return { instructions, simulation, transaction }
}

/**
 * Monta de novo com a carteira real e um blockhash novo, assina e envia.
 * Carteiras Wallet Standard assinam e enviam; carteiras sintéticas (localnet) só assinam e o Desk envia.
 * onSent journals the intended submission as soon as its signature is known; it is not proof of broadcast.
 */
export async function signAndSend(
  ctx: ApiContext,
  request: PlanRequest,
  signer: TransactionSigner,
  unitsConsumed?: number,
  onSent?: (signature: Signature) => void,
): Promise<Signature> {
  if (signer.address !== requiredSignerOf(request)) throw new Error('connected wallet is not the required signer')
  const instructions = await buildInstructions(ctx, request, signer)
  const units = Math.min(SIMULATION_CU_LIMIT, Math.ceil((unitsConsumed ?? 400_000) * CU_MARGIN))
  const blockhash = await latestBlockhash(ctx)
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions([getSetComputeUnitLimitInstruction({ units }), ...instructions], m),
  )
  const notify = (signature: Signature) => {
    try { onSent?.(signature) } catch { /* Receipt callbacks must not interrupt submission. */ }
  }
  if (isTransactionSendingSigner(signer)) {
    try {
      const bytes = await signAndSendTransactionMessageWithSigners(message)
      const signature = getBase58Decoder().decode(bytes) as Signature
      notify(signature)
      return signature
    } catch (error) {
      // Wallet error messages cannot establish that no broadcast occurred.
      throw new SubmissionUnknownError(error)
    }
  }
  const signed = await signTransactionMessageWithSigners(message)
  let signature: Signature | undefined
  try {
    signature = getSignatureFromTransaction(signed)
    notify(signature)
    const wire = getBase64EncodedWireTransaction(signed)
    await rpcCall(() => ctx.rpc.sendTransaction(wire, { encoding: 'base64', preflightCommitment: ctx.commitment }).send())
    return signature
  } catch (error) {
    throw new SubmissionUnknownError(error, signature)
  }
}

export type ConfirmationStatus = 'confirmed' | 'failed' | 'unknown'

export interface Confirmation {
  status: ConfirmationStatus
  slot?: number
  logs: string[]
  error?: DiagnosticReason
}

/** Poll until the selected commitment or deadline. An unknown result never authorizes resubmission. */
export async function confirmSignature(ctx: ApiContext, signature: Signature, timeoutMs = 45_000): Promise<Confirmation> {
  const deadline = Date.now() + timeoutMs
  const timedOut = Symbol('confirmation deadline')
  // Bound every RPC await, including logs, even if the transport never settles.
  async function withinDeadline<T>(request: (signal: AbortSignal) => Promise<T>): Promise<T | typeof timedOut> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        request(controller.signal),
        new Promise<typeof timedOut>((resolve) => {
          timer = setTimeout(() => {
            // Settle the timeout first so an abort rejection cannot win the race.
            resolve(timedOut)
            controller.abort()
          }, Math.max(0, deadline - Date.now()))
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  while (Date.now() < deadline) {
    let status
    try {
      const response = await withinDeadline((signal) =>
        ctx.rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send({ abortSignal: signal }),
      )
      if (response === timedOut) break
      status = response.value[0]
    } catch {
      status = undefined
    }
    const reachedCommitment = status && (
      status.confirmationStatus === 'finalized' ||
      (ctx.commitment !== 'finalized' && status.confirmationStatus === 'confirmed') ||
      (ctx.commitment === 'processed' && status.confirmationStatus === 'processed' && !status.err)
    )
    // A processed error can disappear with its fork; require at least confirmed failure evidence.
    if (status && reachedCommitment) {
      const logs = await withinDeadline((signal) => transactionLogs(ctx, signature, signal))
      if (logs === timedOut) break
      if (status.err) return { status: 'failed', slot: Number(status.slot), logs, error: failureReason(status.err, logs, ctx.programId) }
      return { status: 'confirmed', slot: Number(status.slot), logs }
    }
    const remaining = deadline - Date.now()
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(1200, remaining)))
  }
  return { status: 'unknown', logs: [], error: reason('ConfirmationUnknown', 'confirmation timed out') }
}

async function transactionLogs(ctx: ApiContext, signature: Signature, signal?: AbortSignal): Promise<string[]> {
  try {
    const tx = await ctx.rpc
      .getTransaction(signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: ctx.commitment === 'finalized' ? 'finalized' : 'confirmed' })
      .send({ abortSignal: signal })
    return [...(tx?.meta?.logMessages ?? [])]
  } catch {
    return []
  }
}

/** Read back observed ATA balances; absent accounts are zero, invalid accounts reject the read. */
export async function tokenBalances(ctx: ApiContext, mint: Address, owners: Address[]): Promise<{ slot: number; balances: bigint[] }> {
  const accounts = await tokenAccountsFor(mint, owners)
  const { slot, accounts: raw } = await readAccounts(ctx, accounts)
  return {
    slot,
    balances: raw.map((account, i) => decodeTokenBalance(account, { address: accounts[i]!, mint, owner: owners[i]! })),
  }
}
