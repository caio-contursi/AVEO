import {
  AccountRole, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage,
  getBase64EncodedWireTransaction, isSolanaError, partiallySignTransaction, pipe, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_SIGNATURE_VERIFICATION_FAILURE,
  type AccountMeta, type Address, type Instruction, type KeyPairSigner,
} from '@solana/kit'
import { findAssociatedTokenPda, getTokenDecoder, resolveExtraAccountMetasForExecute } from '@solana-program/token-2022'
import { readAccounts, type RawAccount } from '../src/api/accounts'
import { decodeEligibilityBinding, decodeIssuerPolicy } from '../src/api/codecs'
import { TOKEN_2022_PROGRAM_ID } from '../src/api/constants'
import type { ApiContext } from '../src/api/context'
import { getSetBindingInstruction, getUpdatePolicyInstruction } from '../src/api/instructions'
import { findBindingPda, findExtraAccountMetasPda, findPolicyPda } from '../src/api/pdas'
import type { PublicEvidence } from './acceptance-report'

export const AUTHORIZATION_STAGES = [
  'direct-hook-execute-rejected',
  'unsigned-policy-update-rejected',
  'unsigned-binding-rejected',
] as const
export type AuthorizationStage = typeof AUTHORIZATION_STAGES[number]

export interface AuthorizationChecksInput {
  ctx: ApiContext
  treasury: KeyPairSigner
  x: KeyPairSigner
  asset: { mint: Address }
  // The parent owns signing, ledger confirmation, and exact hook log assertions.
  reject: (payer: KeyPairSigner, instructions: Instruction[], expectedCode: 'NotTransferContext') => Promise<{ slot?: number }>
  emit: (evidence: PublicEvidence) => void
  completeStage: (stage: AuthorizationStage) => void
}

function requireCheck(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function requireLocalAuthorizationContext(ctx: ApiContext): void {
  requireCheck(ctx.cluster === 'localnet', 'Authorization acceptance requires localnet')
  let url: URL
  try { url = new URL(ctx.rpcUrl) } catch { throw new Error('Invalid authorization RPC endpoint') }
  requireCheck(['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) &&
    !url.username && !url.password && !url.search && !url.hash && url.pathname === '/',
    'Authorization acceptance requires a credential-free loopback root RPC endpoint')
}

export function expectAuthorizationAccountUnchanged(before: RawAccount | null, after: RawAccount | null): void {
  requireCheck(before && after, 'Protected account must exist before and after rejection')
  requireCheck(before.address === after.address && before.owner === after.owner && before.lamports === after.lamports &&
    before.executable === after.executable && before.data.length === after.data.length &&
    before.data.every((byte, index) => byte === after.data[index]), 'Rejected authorization changed a protected account')
}

export function isSignatureVerificationFailure(error: unknown): boolean {
  return isSolanaError(error, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_SIGNATURE_VERIFICATION_FAILURE)
}

/** The official resolver returns extras, hook program, then validation account; Execute uses validation first. */
export function directExecuteInstruction(input: {
  programId: Address; source: Address; mint: Address; destination: Address; owner: Address
  validation: Address; resolved: readonly AccountMeta[]
}): Instruction {
  const { resolved } = input
  requireCheck(resolved.length === 11 && resolved[9]?.address === input.programId && resolved[10]?.address === input.validation,
    'Official resolver must return all nine Aveo extras followed by hook and validation accounts')
  // spl-transfer-hook-interface:execute, as encoded by the installed official Token-2022 client.
  const data = new Uint8Array([105, 37, 101, 197, 75, 251, 102, 26, 1, 0, 0, 0, 0, 0, 0, 0])
  return {
    programAddress: input.programId,
    accounts: [input.source, input.mint, input.destination, input.owner, input.validation]
      .map((address) => ({ address, role: AccountRole.READONLY })).concat(resolved.slice(0, 9)),
    data,
  }
}

/** Sign only the distinct fee payer, leaving exactly the required authority unsigned. */
export async function rejectUnsignedAuthority(ctx: ApiContext, instruction: Instruction, payer: KeyPairSigner, authority: Address): Promise<void> {
  requireLocalAuthorizationContext(ctx)
  requireCheck(payer.address !== authority, 'Missing authority test requires a distinct fee payer')
  const stripped: Instruction = {
    ...instruction,
    accounts: instruction.accounts?.map(({ address, role }) => ({ address, role })),
  }
  const { value: blockhash } = await ctx.rpc.getLatestBlockhash({ commitment: ctx.commitment }).send()
  const transaction = compileTransaction(pipe(
    createTransactionMessage({ version: 0 }),
    (message) => setTransactionMessageFeePayer(payer.address, message),
    (message) => setTransactionMessageLifetimeUsingBlockhash(blockhash, message),
    (message) => appendTransactionMessageInstructions([stripped], message),
  ))
  requireCheck(Object.hasOwn(transaction.signatures, authority) && transaction.signatures[authority] === null,
    'Required authority must have an empty signature slot')
  requireCheck(Object.values(transaction.signatures).every((signature) => signature === null), 'Unsigned test must contain no injected signatures')
  requireCheck(Object.keys(transaction.signatures).length === 2 && Object.hasOwn(transaction.signatures, payer.address),
    'Only the fee payer and required authority may be required signers')
  const signed = await partiallySignTransaction([payer.keyPair], transaction)
  requireCheck(signed.signatures[payer.address]?.some((byte) => byte !== 0) && signed.signatures[authority] === null,
    'Only the fee payer must be signed; the required authority must remain unsigned')
  try {
    // Preflight verifies signatures and returns the specific validator RPC error (-32003).
    await ctx.rpc.sendTransaction(getBase64EncodedWireTransaction(signed), {
      encoding: 'base64', skipPreflight: false, preflightCommitment: ctx.commitment, maxRetries: 0n,
    }).send()
  } catch (error) {
    if (isSignatureVerificationFailure(error)) return
    throw new Error('Unsigned transaction did not produce validator signature verification failure', { cause: error })
  }
  throw new Error('Validator unexpectedly accepted an unsigned authority transaction')
}

/** Call only from the parent's guarded localnet acceptance runner with synthetic signers. */
export async function runAuthorizationChecks(input: AuthorizationChecksInput): Promise<void> {
  const { ctx, treasury, x, asset, emit, completeStage } = input
  requireLocalAuthorizationContext(ctx)
  requireCheck(treasury.address !== x.address, 'Treasury and X must be distinct synthetic subjects')
  const [[source], [destination], validation, policyAddress, bindingAddress] = await Promise.all([
    findAssociatedTokenPda({ owner: treasury.address, mint: asset.mint, tokenProgram: TOKEN_2022_PROGRAM_ID }),
    findAssociatedTokenPda({ owner: x.address, mint: asset.mint, tokenProgram: TOKEN_2022_PROGRAM_ID }),
    findExtraAccountMetasPda(ctx.programId, asset.mint), findPolicyPda(ctx.programId, asset.mint),
    findBindingPda(ctx.programId, asset.mint, x.address),
  ])
  const resolved = await resolveExtraAccountMetasForExecute({ rpc: ctx.rpc, transferHookProgramAddress: ctx.programId,
    source, mint: asset.mint, destination, owner: treasury.address, amount: 1n })
  const instruction = directExecuteInstruction({ programId: ctx.programId, source, mint: asset.mint,
    destination, owner: treasury.address, validation, resolved })
  const protectedAddresses = [...new Set(instruction.accounts!.map((account) => account.address))]
  requireCheck(!protectedAddresses.includes(x.address), 'Direct Execute fee payer must not be a protected account')
  const before = await readAccounts(ctx, protectedAddresses)
  const tokenAmounts = (accounts: (RawAccount | null)[]) => [source, destination].map((address) => {
    const account = accounts[protectedAddresses.indexOf(address)]
    requireCheck(account?.owner === TOKEN_2022_PROGRAM_ID, 'Direct Execute token accounts must exist and belong to Token-2022')
    return getTokenDecoder().decode(account.data).amount
  })
  const balancesBefore = tokenAmounts(before.accounts)
  requireCheck(balancesBefore[0]! > 0n, 'Direct Execute source must have tokens')
  const confirmation = await input.reject(x, [instruction], 'NotTransferContext')
  requireCheck(confirmation.slot !== undefined, 'Direct Execute rejection must be recorded in the ledger')
  // X pays the failed transaction fee; the treasury authority and every Execute account remain unchanged.
  const after = await readAccounts(ctx, protectedAddresses, Math.max(before.slot, confirmation.slot))
  protectedAddresses.forEach((protectedAccount, index) => {
    expectAuthorizationAccountUnchanged(before.accounts[index] ?? null, after.accounts[index] ?? null)
    emit({ protectedAccount, accountUnchanged: true, beforeSlot: before.slot, afterSlot: after.slot, hookCode: 'NotTransferContext' })
  })
  emit({ source: treasury.address, destination: x.address, accepted: false, hookCode: 'NotTransferContext',
    before: balancesBefore.map(String), after: tokenAmounts(after.accounts).map(String), slot: after.slot })
  completeStage(AUTHORIZATION_STAGES[0])

  const accounts = await readAccounts(ctx, [policyAddress, bindingAddress])
  requireCheck(accounts.accounts[0]?.owner === ctx.programId && accounts.accounts[1]?.owner === ctx.programId,
    'Policy and existing X binding must be owned by the hook')
  const policy = decodeIssuerPolicy(accounts.accounts[0].data)
  const binding = decodeEligibilityBinding(accounts.accounts[1].data)
  requireCheck(policy.mint === asset.mint && binding.mint === asset.mint && binding.subjectWallet === x.address,
    'Authorization fixtures must match the selected asset and X')
  requireCheck(policy.issuerAuthority !== x.address, 'X must be distinct from the required policy issuer')
  // Supply the required signer meta without access to the issuer's keypair.
  const authority = { address: policy.issuerAuthority, signTransactions: async () => {
    throw new Error('Missing-authority acceptance must never invoke the issuer signer')
  } }
  const update = await getUpdatePolicyInstruction({ programId: ctx.programId, authority, mint: asset.mint,
    args: { proofDomain: policy.proofDomain, pairs: policy.pairs, requireKyc: policy.requireKyc,
      requireAccredited: policy.requireAccredited, active: !policy.active } })
  const bind = await getSetBindingInstruction({ programId: ctx.programId, subject: x, mint: asset.mint,
    credential: binding.credential, schema: binding.schema, attestation: binding.attestation })
  for (const [stage, operation, signer, target, payer] of [
    [AUTHORIZATION_STAGES[1], update, policy.issuerAuthority, policyAddress, x],
    [AUTHORIZATION_STAGES[2], bind, x.address, bindingAddress, treasury],
  ] as const) {
    const snapshot = await readAccounts(ctx, [target])
    await rejectUnsignedAuthority(ctx, operation, payer, signer)
    const readback = await readAccounts(ctx, [target], snapshot.slot)
    expectAuthorizationAccountUnchanged(snapshot.accounts[0] ?? null, readback.accounts[0] ?? null)
    // Validator signature rejection never reaches the ledger; these slots describe account reads only.
    emit({ signer, protectedAccount: target, accountUnchanged: true, accepted: false,
      validatorError: 'SignatureVerificationFailure',
      beforeSlot: snapshot.slot, afterSlot: readback.slot })
    completeStage(stage)
  }
}
