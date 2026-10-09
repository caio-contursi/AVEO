// T16 local acceptance: raw Token-2022 transfers, with public evidence only.
import assert from 'node:assert/strict'
import { getCreateAccountInstruction } from '@solana-program/system'
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget'
import {
  findAssociatedTokenPda, getCloseAccountInstruction, getInitializeAccount3Instruction,
  getTokenDecoder, getTokenSize, getTransferCheckedInstruction,
  resolveExtraAccountMetasForExecute, TOKEN_2022_ERROR__INSUFFICIENT_FUNDS,
} from '@solana-program/token-2022'
import {
  appendTransactionMessageInstructions, createTransactionMessage, generateKeyPairSigner,
  getBase64EncodedWireTransaction, getSignatureFromTransaction, pipe,
  setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners, type Address, type Instruction, type KeyPairSigner, type Signature,
} from '@solana/kit'
import { readAccounts } from '../src/api/accounts'
import { TOKEN_2022_PROGRAM_ID } from '../src/api/constants'
import type { ApiContext } from '../src/api/context'
import { confirmSignature } from '../src/api/transactions'
import type { DeploymentAsset } from '../src/config/deployment'
import type { PublicEvidence } from './acceptance-report'

export const BOUNDARY_STAGES = [
  'boundary-zero-amount', 'boundary-excessive-amount', 'boundary-max-u64-rejected', 'boundary-exact-balance',
  'boundary-same-owner-distinct-accounts', 'boundary-fixtures-restored',
] as const

export interface BoundaryCheckOptions {
  ctx: ApiContext
  treasurySigner: KeyPairSigner
  xSigner: KeyPairSigner
  walletX: Address
  asset: DeploymentAsset
  /** Parent must authorize synthetic signers and validate all endpoints before invocation. */
  loopbackAuthorized: true
  evidence: (data: PublicEvidence) => void
  passStage: (stage: typeof BOUNDARY_STAGES[number]) => void
}

export function expectBoundaryDelta(before: readonly bigint[], after: readonly bigint[], amount: bigint): void {
  assert.equal(before.length, 2, 'Expected two source/destination balances')
  assert.equal(after.length, 2, 'Expected two source/destination balances')
  assert(amount >= 0n && before.every((n) => n >= 0n) && after.every((n) => n >= 0n), 'Invalid token amount')
  assert.equal(after[0], before[0]! - amount, 'Source balance delta mismatch')
  assert.equal(after[1], before[1]! + amount, 'Destination balance delta mismatch')
  assert.equal(after[0]! + after[1]!, before[0]! + before[1]!, 'Token conservation mismatch')
}

export function expectInsufficientFunds(error: unknown, logs: readonly string[]): void {
  assert(error && typeof error === 'object' && 'InstructionError' in error, 'Missing ledger instruction error')
  const instructionError = error.InstructionError
  // The compute budget is instruction zero; the raw transfer is instruction one.
  assert(Array.isArray(instructionError) && instructionError.length === 2
    && (instructionError[0] === 1 || instructionError[0] === 1n), 'Wrong failing instruction')
  const code: unknown = instructionError[1]
  assert(code && typeof code === 'object' && 'Custom' in code
    && (code.Custom === TOKEN_2022_ERROR__INSUFFICIENT_FUNDS
      || code.Custom === BigInt(TOKEN_2022_ERROR__INSUFFICIENT_FUNDS)), 'Expected canonical Token-2022 InsufficientFunds')
  assert(logs.includes(`Program ${TOKEN_2022_PROGRAM_ID} invoke [1]`), 'Token-2022 must execute directly')
  assert(logs.includes('Program log: Error: insufficient funds'), 'Missing Token-2022 insufficient funds diagnostic')
  const failures = logs.filter((line) => /^Program \S+ failed:/.test(line))
  assert.deepEqual(failures, [`Program ${TOKEN_2022_PROGRAM_ID} failed: custom program error: 0x1`],
    'Failure must originate in Token-2022, not a nested hook')
}

function requireAuthorizedLocalContext(options: BoundaryCheckOptions): void {
  assert.equal(options.loopbackAuthorized, true, 'Parent loopback authorization required')
  const { ctx } = options
  const url = new URL(ctx.rpcUrl)
  assert(['http:', 'https:'].includes(url.protocol)
    && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'Loopback RPC required')
  assert.equal(ctx.cluster, 'localnet', 'Local synthetic fixtures required')
  assert(['confirmed', 'finalized'].includes(ctx.commitment), 'Confirmed ledger commitment required')
  assert.equal(options.xSigner.address, options.walletX, 'X signer does not match wallet X')
  assert.notEqual(options.treasurySigner.address, options.walletX, 'Distinct fixture owners required')
}

export async function runBoundaryChecks(options: BoundaryCheckOptions): Promise<void> {
  requireAuthorizedLocalContext(options)
  const { ctx, treasurySigner, xSigner, walletX, asset, evidence, passStage } = options
  const assetId = asset.id
  assert(assetId === 'alfa' || assetId === 'beta', 'Expected public demo asset')
  const [[treasuryAccount], [xAccount]] = await Promise.all(
    [treasurySigner.address, walletX].map((owner) => findAssociatedTokenPda({ owner, mint: asset.mint, tokenProgram: TOKEN_2022_PROGRAM_ID })),
  )
  const decoder = getTokenDecoder()
  const readPair = async (addresses: Address[], owners: Address[], minSlot?: number) => {
    const read = await readAccounts(ctx, addresses, minSlot)
    const balances = read.accounts.map((raw, i) => {
      assert(raw && raw.owner === TOKEN_2022_PROGRAM_ID && !raw.executable, 'Expected live Token-2022 account')
      const token = decoder.decode(raw.data)
      assert.equal(token.mint, asset.mint, 'Token mint mismatch')
      assert.equal(token.owner, owners[i], 'Actual token owner mismatch')
      return token.amount
    })
    return { slot: read.slot, balances }
  }
  const owners = [treasurySigner.address, walletX]
  const initial = await readPair([treasuryAccount, xAccount], owners)
  assert(initial.balances[0]! >= 2n, 'Treasury must retain ample demo tokens after restoration')
  assert(initial.balances[0]! < 0xffff_ffff_ffff_ffffn, 'Excessive amount must fit u64')
  let pendingSignature: Signature | undefined
  let lastSlot = initial.slot
  let cleaningUp = false
  const failures: unknown[] = []
  const emitEvidence = (data: PublicEvidence) => {
    if (!cleaningUp) { evidence(data); return }
    // A reporting failure must not strand a known-empty auxiliary account's rent.
    try { evidence(data) } catch (error) { failures.push(error) }
  }
  const submit = async (instructions: Instruction[], rejected = false) => {
    const { value: blockhash } = await ctx.rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
    const message = pipe(createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(treasurySigner, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions([getSetComputeUnitLimitInstruction({ units: 1_000_000 }), ...instructions], m))
    const signed = await signTransactionMessageWithSigners(message)
    const signature = getSignatureFromTransaction(signed)
    pendingSignature = signature
    await ctx.rpc.sendTransaction(getBase64EncodedWireTransaction(signed), {
      encoding: 'base64', skipPreflight: rejected, preflightCommitment: 'confirmed',
    }).send()
    let confirmation = await confirmSignature(ctx, signature)
    for (let attempt = 0; confirmation.status === 'failed' && confirmation.logs.length === 0 && attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200))
      confirmation = await confirmSignature(ctx, signature)
    }
    assert(confirmation.status !== 'unknown' && confirmation.slot !== undefined
      && Number.isSafeInteger(confirmation.slot) && confirmation.slot >= 0, 'Missing confirmed ledger outcome')
    pendingSignature = undefined
    lastSlot = Math.max(lastSlot, confirmation.slot)
    assert.equal(confirmation.status, rejected ? 'failed' : 'confirmed', 'Unexpected ledger result')
    if (rejected) {
      const { value: statuses } = await ctx.rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send()
      const status = statuses[0]
      assert(status && Number(status.slot) === confirmation.slot
        && ['confirmed', 'finalized'].includes(status.confirmationStatus ?? ''), 'Failure must be confirmed in ledger')
      expectInsufficientFunds(status.err, confirmation.logs)
    }
    emitEvidence({ signature, slot: confirmation.slot, status: confirmation.status,
      ...(rejected ? { validatorError: 'TokenInsufficientFunds' as const } : {}) })
    return confirmation.slot
  }
  const transfer = async (source: Address, destination: Address, authority: KeyPairSigner, amount: bigint) => {
    const raw = getTransferCheckedInstruction({ source, mint: asset.mint, destination, authority, amount, decimals: asset.decimals })
    const extra = await resolveExtraAccountMetasForExecute({ rpc: ctx.rpc, transferHookProgramAddress: ctx.programId,
      source, mint: asset.mint, destination, owner: authority.address, amount })
    assert(extra.length > 0, 'Official resolver must return hook accounts')
    return { ...raw, accounts: [...raw.accounts, ...extra] }
  }
  const recordBalances = (source: Address, destination: Address, before: bigint[], after: bigint[], slot: number, accepted: boolean, amount?: bigint) => {
    emitEvidence({ asset: assetId, source, destination, accepted,
      before: before.map(String), after: after.map(String), slot,
      ...(amount !== undefined ? { amount: amount.toString() } : {}) })
  }
  const attempt = async (amount: bigint, rejected = false) => {
    const before = await readPair([treasuryAccount, xAccount], owners, lastSlot)
    const slot = await submit([await transfer(treasuryAccount, xAccount, treasurySigner, amount)], rejected)
    const after = await readPair([treasuryAccount, xAccount], owners, slot)
    expectBoundaryDelta(before.balances, after.balances, rejected ? 0n : amount)
    recordBalances(treasuryAccount, xAccount, before.balances, after.balances, after.slot, !rejected, amount)
  }
  const auxiliary = await generateKeyPairSigner()
  let auxiliaryAttempted = false
  let exactAttempted = false
  let completed = false
  try {
    await attempt(0n)
    passStage(BOUNDARY_STAGES[0])
    await attempt(initial.balances[0]! + 1n, true)
    passStage(BOUNDARY_STAGES[1])
    await attempt(0xffff_ffff_ffff_ffffn, true)
    passStage(BOUNDARY_STAGES[2])
    exactAttempted = true
    await attempt(initial.balances[0]!)
    // Restore promptly while X's proof is valid; finally retries only from known ledger state.
    await restoreExact()
    exactAttempted = false
    passStage(BOUNDARY_STAGES[3])
    assert.notEqual(auxiliary.address, treasuryAccount, 'Same-owner test needs distinct accounts')
    // InitializeAccount3 adds the mint's required TransferHookAccount extension.
    const space = getTokenSize([{ __kind: 'TransferHookAccount', transferring: false }])
    const rent = await ctx.rpc.getMinimumBalanceForRentExemption(BigInt(space)).send()
    auxiliaryAttempted = true
    await submit([
      getCreateAccountInstruction({ payer: treasurySigner, newAccount: auxiliary, lamports: rent, space, programAddress: TOKEN_2022_PROGRAM_ID }),
      getInitializeAccount3Instruction({ account: auxiliary.address, mint: asset.mint, owner: treasurySigner.address }),
    ])
    const sameOwners = [treasurySigner.address, treasurySigner.address]
    const before = await readPair([treasuryAccount, auxiliary.address], sameOwners, lastSlot)
    assert.equal(before.balances[1], 0n, 'Fresh auxiliary account must be empty')
    const slot = await submit([await transfer(treasuryAccount, auxiliary.address, treasurySigner, 1n)])
    const after = await readPair([treasuryAccount, auxiliary.address], sameOwners, slot)
    expectBoundaryDelta(before.balances, after.balances, 1n)
    recordBalances(treasuryAccount, auxiliary.address, before.balances, after.balances, after.slot, true, 1n)
    passStage(BOUNDARY_STAGES[4])
    completed = true
  } catch (error) {
    failures.push(error)
  } finally {
    cleaningUp = true
    // Never replay transfers after an uncertain send; reconcile that signature first.
    if (pendingSignature) {
      try {
        const result = await confirmSignature(ctx, pendingSignature)
        assert(result.status !== 'unknown' && result.slot !== undefined, 'Cleanup unsafe: transaction outcome remains unknown')
        lastSlot = Math.max(lastSlot, result.slot)
        pendingSignature = undefined
      } catch (error) { failures.push(error) }
    }
    if (!pendingSignature) {
      if (exactAttempted) {
        try { await restoreExact() } catch (error) { failures.push(error) }
      }
      if (auxiliaryAttempted && !pendingSignature) {
        try {
          const { accounts } = await readAccounts(ctx, [auxiliary.address], lastSlot)
          const raw = accounts[0]
          if (raw) {
            assert.equal(raw.owner, TOKEN_2022_PROGRAM_ID, 'Cleanup account program mismatch')
            const token = decoder.decode(raw.data)
            assert(token.owner === treasurySigner.address && token.mint === asset.mint, 'Unsafe auxiliary cleanup owner/mint')
            assert(token.amount === 0n || token.amount === 1n, 'Unsafe auxiliary cleanup amount')
            if (token.amount === 1n) {
              const before = await readPair([auxiliary.address, treasuryAccount], [treasurySigner.address, treasurySigner.address], lastSlot)
              const slot = await submit([await transfer(auxiliary.address, treasuryAccount, treasurySigner, 1n)])
              const after = await readPair([auxiliary.address, treasuryAccount], [treasurySigner.address, treasurySigner.address], slot)
              expectBoundaryDelta(before.balances, after.balances, 1n)
              recordBalances(auxiliary.address, treasuryAccount, before.balances, after.balances, after.slot, true, 1n)
            }
            await submit([getCloseAccountInstruction({ account: auxiliary.address, destination: treasurySigner.address, owner: treasurySigner })])
            const closed = await readAccounts(ctx, [auxiliary.address], lastSlot)
            assert.equal(closed.accounts[0], null, 'Auxiliary account must be closed and rent returned')
          }
        } catch (error) { failures.push(error) }
      }
      try {
        const restored = await readPair([treasuryAccount, xAccount], owners, lastSlot)
        expectBoundaryDelta(initial.balances, restored.balances, 0n)
        recordBalances(treasuryAccount, xAccount, initial.balances, restored.balances, restored.slot, true)
      } catch (error) { failures.push(error) }
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Boundary acceptance or safe fixture cleanup failed')
  assert(completed, 'Boundary acceptance incomplete')
  passStage(BOUNDARY_STAGES[5])

  async function restoreExact(): Promise<void> {
    const before = await readPair([treasuryAccount, xAccount], owners, lastSlot)
    if (before.balances[0] === initial.balances[0] && before.balances[1] === initial.balances[1]) return
    assert(before.balances[0] === 0n && before.balances[1] === initial.balances[1]! + initial.balances[0]!,
      'Unsafe exact-balance restoration: unexpected fixture balances')
    const slot = await submit([await transfer(xAccount, treasuryAccount, xSigner, initial.balances[0]!)])
    const after = await readPair([xAccount, treasuryAccount], [walletX, treasurySigner.address], slot)
    expectBoundaryDelta([before.balances[1]!, before.balances[0]!], after.balances, initial.balances[0]!)
    recordBalances(xAccount, treasuryAccount, [before.balances[1]!, before.balances[0]!], after.balances, after.slot, true, initial.balances[0]!)
  }
}
