// Montagem, simulação, envio e verificação de transações.
// O Desk nunca guarda chave: quem assina é a carteira conectada (ou, só em localnet, uma carteira sintética).
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget'
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getTokenDecoder,
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
import type { PolicyArgs } from './codecs'
import type { ApiContext } from './context'
import { reason, type DiagnosticReason } from './diagnostics'
import { failureReason } from './errors'
import { getSetBindingInstruction, getUpdatePolicyInstruction } from './instructions'

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
      mint: Address
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

export async function tokenAccountsFor(mint: Address, owners: Address[]): Promise<Address[]> {
  return Promise.all(
    owners.map(async (owner) => (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }))[0]),
  )
}

/** Monta as instruções de um pedido. `signer` é a carteira real ou um NoopSigner (para simular). */
export async function buildInstructions(ctx: ApiContext, request: PlanRequest, signer: TransactionSigner): Promise<Instruction[]> {
  switch (request.kind) {
    case 'set-binding':
      return [
        await getSetBindingInstruction({
          programId: ctx.programId,
          subject: signer,
          mint: request.mint,
          credential: request.credential,
          schema: request.schema,
          attestation: request.attestation,
        }),
      ]
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
        // Resolução oficial a partir da ExtraAccountMetaList do mint (owner → binding → contas SAS).
        extra = await resolveExtraAccountMetasForExecute({
          rpc: ctx.rpc,
          transferHookProgramAddress: ctx.programId,
          source: source!,
          mint: request.mint,
          destination: destination!,
          owner: request.sourceOwner,
          amount: request.amount,
        })
      } catch (error) {
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
  return rpcCall(async () => (await ctx.rpc.getLatestBlockhash({ commitment: ctx.commitment }).send()).value)
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
  const { value } = await rpcCall(() =>
    ctx.rpc
      .simulateTransaction(wire, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: ctx.commitment })
      .send(),
  )
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
  const feePayer = requiredSignerOf(request)
  const instructions = await buildInstructions(ctx, request, createNoopSigner(feePayer))
  const simulation = await simulate(ctx, instructions, feePayer)
  const transaction = await unsignedTransaction(ctx, instructions, feePayer)
  return { instructions, simulation, transaction }
}

/**
 * Monta de novo com a carteira real e um blockhash novo, assina e envia.
 * Carteiras Wallet Standard assinam e enviam; carteiras sintéticas (localnet) só assinam e o Desk envia.
 */
export async function signAndSend(
  ctx: ApiContext,
  request: PlanRequest,
  signer: TransactionSigner,
  unitsConsumed?: number,
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
  if (isTransactionSendingSigner(signer)) {
    const bytes = await signAndSendTransactionMessageWithSigners(message)
    return getBase58Decoder().decode(bytes) as Signature
  }
  const signed = await signTransactionMessageWithSigners(message)
  const wire = getBase64EncodedWireTransaction(signed)
  await rpcCall(() => ctx.rpc.sendTransaction(wire, { encoding: 'base64', preflightCommitment: ctx.commitment }).send())
  return getSignatureFromTransaction(signed)
}

export type ConfirmationStatus = 'confirmed' | 'failed' | 'unknown'

export interface Confirmation {
  status: ConfirmationStatus
  slot?: number
  logs: string[]
  error?: DiagnosticReason
}

/** Consulta a assinatura até confirmar ou esgotar o tempo. Resultado desconhecido não autoriza reenvio. */
export async function confirmSignature(ctx: ApiContext, signature: Signature, timeoutMs = 45_000): Promise<Confirmation> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    let status
    try {
      const { value } = await ctx.rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send()
      status = value[0]
    } catch {
      status = undefined
    }
    if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized' || status.err)) {
      const logs = await transactionLogs(ctx, signature)
      if (status.err) return { status: 'failed', slot: Number(status.slot), logs, error: failureReason(status.err, logs, ctx.programId) }
      return { status: 'confirmed', slot: Number(status.slot), logs }
    }
    await new Promise((resolve) => setTimeout(resolve, 1200))
  }
  return { status: 'unknown', logs: [], error: reason('ConfirmationUnknown', 'confirmation timed out') }
}

async function transactionLogs(ctx: ApiContext, signature: Signature): Promise<string[]> {
  try {
    const tx = await ctx.rpc
      .getTransaction(signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
      .send()
    return [...(tx?.meta?.logMessages ?? [])]
  } catch {
    return []
  }
}

/** Saldos das token accounts (readback). Conta inexistente vale 0. */
export async function tokenBalances(ctx: ApiContext, mint: Address, owners: Address[]): Promise<{ slot: number; balances: bigint[] }> {
  const accounts = await tokenAccountsFor(mint, owners)
  const { slot, accounts: raw } = await readAccounts(ctx, accounts)
  const decoder = getTokenDecoder()
  return {
    slot,
    balances: raw.map((account) => {
      if (!account) return 0n
      try {
        return decoder.decode(account.data).amount
      } catch {
        return 0n
      }
    }),
  }
}
