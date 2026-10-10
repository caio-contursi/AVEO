// Localnet acceptance runner. Requires fixtures; repeat runs renew X's proof in place.
// pnpm --filter @aveo/app exec tsx scripts/demo-check.ts [--self-test]
// Evidence contains public addresses, signatures, slots, codes, token balances and delegated allowances only.
import assert from 'node:assert/strict'
import { DEMO_ACCEPTANCE_MANIFEST } from './acceptance-stages'
import { runSchemaValidityChecks } from './schema-validity-checks'
import { runSasAdversarialChecks } from './sas-adversarial-checks'
import { runMissingBindingChecks, runMissingSourceBindingChecks, type MissingBindingChecksInput, type MissingBindingRejection } from './missing-binding-checks'
import type { AdversarialContext } from './adversarial-context'
import { runAuthorizationChecks } from './authorization-checks'
import { runBoundaryChecks } from './boundary-checks'
import { existsSync } from 'node:fs'
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget'
import { findAssociatedTokenPda, getApproveCheckedInstruction, getRevokeInstruction, getTokenDecoder, getTransferCheckedInstruction, resolveExtraAccountMetasForExecute, type Token } from '@solana-program/token-2022'
import {
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from '@solana/kit'
import { getSysvarClockDecoder } from '@solana/sysvars'
import { deriveAttestationPda, getCloseAttestationInstruction, getCreateAttestationInstruction } from 'sas-lib'
import { readAccounts, type RawAccount } from '../src/api/accounts'
import { AveoSasHookBackend } from '../src/api/backend'
import { bytesEqual, decodeIssuerPolicy, encodeEligibilityPayload, type PolicyArgs } from '../src/api/codecs'
import { AVEO_HOOK_PROGRAM_ID, SAS_PROGRAM_ID, SYSVAR_CLOCK_ID, TOKEN_2022_PROGRAM_ID } from '../src/api/constants'
import { createApiContext } from '../src/api/context'
import type { DeskSnapshot, ReasonCode } from '../src/api/diagnostics'
import { inspectEligibility } from '../src/api/eligibility'
import { onchainReasonFromLogs } from '../src/api/errors'
import { getSetBindingInstruction, getUpdatePolicyInstruction } from '../src/api/instructions'
import { findBindingPda, findPolicyPda } from '../src/api/pdas'
import { findProofsForWallet } from '../src/api/proofs'
import { buildInstructions, confirmSignature, simulate, tokenBalances } from '../src/api/transactions'
import { hexToBytes, parseDeployment } from '../src/config/deployment'
import { EMPTY_STORE, applyScan, applyVerification } from '../src/features/incidents/model'
import { checkIncidentPersistence } from './persistence-check'
import { requireLocalGenesis } from './localnet-safety'
import { requireFalseKycSnapshots } from './kyc-checks'
import { DEPLOYMENT_FILE, WALLETS_FILE, RPC_URL, WS_URL, loadDeployment, loadDevWallets, newDevWallet, send, verifyLocalValidator } from './lib'

class ExpectationFailed extends Error {}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ExpectationFailed(message)
}

// Explicit literal loopback hosts prevent accidentally signing against devnet.
function requireLoopback(endpoint: string, protocols: string[]): void {
  let url: URL
  try { url = new URL(endpoint) } catch { throw new ExpectationFailed('Invalid local endpoint') }
  expect(protocols.includes(url.protocol), 'Unexpected endpoint protocol')
  expect(['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname), 'Endpoint must use loopback; public clusters are forbidden')
  expect(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'Endpoint must not contain credentials, query, fragment or a proxy path')
}

function expectVerdict(snapshot: DeskSnapshot, code?: ReasonCode): void {
  expect(snapshot.verdict === (code ? 'ineligible' : 'eligible'), 'Unexpected eligibility verdict')
  expect(snapshot.reasons.find((r) => !r.hint)?.code === code, 'Unexpected primary eligibility reason')
}

function expectBalances(before: bigint[], after: bigint[], accepted: boolean): void {
  expect(before.length === 2 && after.length === 2, 'Expected both token balances')
  expect(after[0] === before[0]! - (accepted ? 1n : 0n), 'Source balance mismatch')
  expect(after[1] === before[1]! + (accepted ? 1n : 0n), 'Destination balance mismatch')
}

function expectDelegation(token: Pick<Token, 'delegate' | 'delegatedAmount'>, delegate: Address | null, allowance: bigint): void {
  expect(delegate === null
    ? token.delegate.__option === 'None'
    : token.delegate.__option === 'Some' && token.delegate.value === delegate, 'Token account delegate mismatch')
  expect(token.delegatedAmount === allowance, 'Delegated allowance mismatch')
}

function expectDelegatedTransfer(before: bigint[], after: bigint[], allowanceBefore: bigint, allowanceAfter: bigint, accepted: boolean): void {
  expect(before[0]! > 0n && allowanceBefore > 0n, 'Delegate requires source tokens and a positive allowance')
  expectBalances(before, after, accepted)
  expect(allowanceAfter === allowanceBefore - (accepted ? 1n : 0n), 'Delegated transfer allowance delta mismatch')
}

function expectHookRejection(logs: readonly string[], expectedCode: ReasonCode): void {
  expect(logs.some((line) => line.startsWith(`Program ${AVEO_HOOK_PROGRAM_ID} failed:`)), 'Rejection must reach and fail the actual hook')
  expect(onchainReasonFromLogs(logs, AVEO_HOOK_PROGRAM_ID)?.code === expectedCode, 'Transfer must fail with the expected hook code')
}

function expectMissingExtraAccountsRejection(status: string, slot: number | undefined, error: unknown, logs: readonly string[]): void {
  expect(status === 'failed' && slot !== undefined && Number.isSafeInteger(slot) && slot >= 0, 'Missing extras must produce a failed transaction with a ledger slot')
  expect(error && typeof error === 'object' && 'InstructionError' in error, 'Missing extras must produce a ledger instruction error')
  const instructionError = error.InstructionError
  // Instruction zero is the compute budget; instruction one is the raw transfer.
  expect(Array.isArray(instructionError) && instructionError.length === 2 && (instructionError[0] === 1 || instructionError[0] === 1n), 'Failure must originate in the external transfer instruction')
  const code: unknown = instructionError[1]
  const tokenFailure = `Program ${TOKEN_2022_PROGRAM_ID} failed: `
  if (code === 'MissingAccount') {
    expect(logs.includes(`${tokenFailure}An account required by the instruction is missing`), 'Token-2022 must report a missing required account')
  } else if (code === 'NotEnoughAccountKeys') {
    expect(logs.includes(`${tokenFailure}insufficient account keys for instruction`), 'Token-2022 must report insufficient account keys')
  } else {
    expect(code && typeof code === 'object' && 'Custom' in code, 'Unexpected error for missing extra accounts')
    // TransferHookError::IncorrectAccount; Anchor AccountNotEnoughKeys if the hook is invoked.
    const custom = Number(code.Custom)
    expect(custom === 2_110_272_652 || custom === 3005, 'Custom error must identify missing required hook accounts')
    expect(logs.includes(`${tokenFailure}custom program error: 0x${custom.toString(16)}`), 'Token-2022 failure log must match the ledger error')
    if (custom === 3005) expect(logs.includes(`Program ${AVEO_HOOK_PROGRAM_ID} failed: custom program error: 0xbbd`), 'Anchor account error must originate in the hook')
  }
}

function expectUnchangedAccount(before: RawAccount | null, after: RawAccount | null): void {
  expect(before && after, 'Protected account must exist before and after rejection')
  expect(before.address === after.address && before.owner === after.owner && before.lamports === after.lamports && before.executable === after.executable && bytesEqual(before.data, after.data), 'Rejected instruction changed the protected account')
}

async function waitForExpiry(readClock: () => Promise<number>, expiry: number, pause: () => Promise<void>, maximumPolls = 110): Promise<number> {
  const deadline = performance.now() + 55_000
  for (let poll = 0; poll < maximumPolls && performance.now() < deadline; poll += 1) {
    const clock = await readClock()
    expect(Number.isSafeInteger(clock), 'Validator Clock must be an integer')
    if (clock >= expiry) return clock
    if (poll + 1 < maximumPolls) await pause()
  }
  throw new ExpectationFailed('Validator Clock did not reach proof expiry within bounded polling')
}

async function selfTest(): Promise<void> {
  for (const endpoint of ['http://127.0.0.1:8899', 'http://[::1]:8899', 'http://localhost:8899']) requireLoopback(endpoint, ['http:'])
  for (const endpoint of ['https://api.devnet.solana.com', 'http://127.0.0.1.evil.test', 'http://0.0.0.0:8899', 'http://user:password@localhost', 'http://localhost/?key=secret', 'http://localhost/proxy', 'not-a-url', 'ws://localhost']) {
    assert.throws(() => requireLoopback(endpoint, ['http:']), ExpectationFailed)
  }
  requireLoopback('ws://127.0.0.1:8900', ['ws:'])
  assert.throws(() => requireLoopback('wss://api.devnet.solana.com', ['ws:', 'wss:']), ExpectationFailed)
  expectBalances([5n, 2n], [4n, 3n], true)
  expectBalances([5n, 2n], [5n, 2n], false)
  assert.throws(() => expectBalances([5n, 2n], [5n, 2n], true), ExpectationFailed)
  assert.throws(() => expectBalances([5n, 2n], [4n, 3n], false), ExpectationFailed)
  assert.throws(() => expectBalances([], [], false), ExpectationFailed)
  const delegated = { delegate: { __option: 'Some' as const, value: AVEO_HOOK_PROGRAM_ID }, delegatedAmount: 10n }
  expectDelegation(delegated, AVEO_HOOK_PROGRAM_ID, 10n)
  expectDelegation({ delegate: { __option: 'None' }, delegatedAmount: 0n }, null, 0n)
  assert.throws(() => expectDelegation(delegated, SAS_PROGRAM_ID, 10n), ExpectationFailed)
  assert.throws(() => expectDelegation(delegated, null, 0n), ExpectationFailed)
  assert.throws(() => expectDelegation(delegated, AVEO_HOOK_PROGRAM_ID, 9n), ExpectationFailed)
  assert.throws(() => expectDelegation({ delegate: { __option: 'None' }, delegatedAmount: 0n }, AVEO_HOOK_PROGRAM_ID, 0n), ExpectationFailed)
  assert.throws(() => expectDelegation({ delegate: { __option: 'None' }, delegatedAmount: 1n }, null, 0n), ExpectationFailed)
  expectDelegatedTransfer([5n, 2n], [4n, 3n], 10n, 9n, true)
  expectDelegatedTransfer([5n, 2n], [5n, 2n], 9n, 9n, false)
  assert.throws(() => expectDelegatedTransfer([5n, 2n], [4n, 3n], 10n, 10n, true), ExpectationFailed)
  assert.throws(() => expectDelegatedTransfer([5n, 2n], [5n, 2n], 9n, 8n, false), ExpectationFailed)
  assert.throws(() => expectDelegatedTransfer([0n, 2n], [0n, 2n], 9n, 9n, false), ExpectationFailed)
  assert.throws(() => expectDelegatedTransfer([5n, 2n], [5n, 2n], 0n, 0n, false), ExpectationFailed)
  const closedLogs = [`Program ${AVEO_HOOK_PROGRAM_ID} failed: custom program error: 0x1777`]
  expectHookRejection(closedLogs, 'AttestationMissingOrClosed')
  assert.throws(() => expectHookRejection(closedLogs, 'AttestationExpired'), ExpectationFailed)
  assert.throws(() => expectHookRejection(['RPC unavailable'], 'AttestationMissingOrClosed'), ExpectationFailed)
  assert.throws(() => expectHookRejection([`Program ${SAS_PROGRAM_ID} failed: custom program error: 0x1777`], 'AttestationMissingOrClosed'), ExpectationFailed)
  const missingLogs = [`Program ${TOKEN_2022_PROGRAM_ID} failed: An account required by the instruction is missing`]
  const missingError = { InstructionError: [1, 'MissingAccount'] }
  expectMissingExtraAccountsRejection('failed', 42, missingError, missingLogs)
  expectMissingExtraAccountsRejection('failed', 42, { InstructionError: [1n, 'MissingAccount'] }, missingLogs)
  expectMissingExtraAccountsRejection('failed', 42, { InstructionError: [1, 'NotEnoughAccountKeys'] }, [`Program ${TOKEN_2022_PROGRAM_ID} failed: insufficient account keys for instruction`])
  for (const custom of [2_110_272_652, 3005]) {
    const logs = [`Program ${TOKEN_2022_PROGRAM_ID} failed: custom program error: 0x${custom.toString(16)}`]
    if (custom === 3005) logs.push(`Program ${AVEO_HOOK_PROGRAM_ID} failed: custom program error: 0xbbd`)
    expectMissingExtraAccountsRejection('failed', 42, { InstructionError: [1, { Custom: custom }] }, logs)
  }
  for (const status of ['confirmed', 'unknown']) assert.throws(() => expectMissingExtraAccountsRejection(status, 42, missingError, missingLogs), ExpectationFailed)
  for (const slot of [undefined, -1, Number.NaN]) assert.throws(() => expectMissingExtraAccountsRejection('failed', slot, missingError, missingLogs), ExpectationFailed)
  for (const error of [null, {}, { InstructionError: [] }, { InstructionError: [true, 'MissingAccount'] }, { InstructionError: [0, 'MissingAccount'] }, { InstructionError: [1, 'InsufficientFunds'] }, { InstructionError: [1, { Custom: 6008 }] }]) {
    assert.throws(() => expectMissingExtraAccountsRejection('failed', 42, error, missingLogs), ExpectationFailed)
  }
  for (const logs of [[], ['RPC unavailable'], [`Program ${SAS_PROGRAM_ID} failed: An account required by the instruction is missing`], [`Program ${TOKEN_2022_PROGRAM_ID} failed: custom program error: 0x1`]]) {
    assert.throws(() => expectMissingExtraAccountsRejection('failed', 42, missingError, logs), ExpectationFailed)
  }
  assert.throws(() => expectMissingExtraAccountsRejection('failed', 42, { InstructionError: [1, { Custom: 3005 }] }, [`Program ${TOKEN_2022_PROGRAM_ID} failed: custom program error: 0xbbd`]), ExpectationFailed)
  assert.throws(() => expectMissingExtraAccountsRejection('failed', 42, { InstructionError: [1, { Custom: 2_110_272_652 }] }, missingLogs), ExpectationFailed)
  const account: RawAccount = { address: AVEO_HOOK_PROGRAM_ID, owner: AVEO_HOOK_PROGRAM_ID, lamports: 10n, executable: false, data: new Uint8Array([1, 2]) }
  expectUnchangedAccount(account, { ...account, data: new Uint8Array([1, 2]) })
  assert.throws(() => expectUnchangedAccount(account, { ...account, data: new Uint8Array([1, 3]) }), ExpectationFailed)
  assert.throws(() => expectUnchangedAccount(account, { ...account, lamports: 11n }), ExpectationFailed)
  assert.throws(() => expectUnchangedAccount(account, { ...account, owner: SAS_PROGRAM_ID }), ExpectationFailed)
  assert.throws(() => expectUnchangedAccount(account, null), ExpectationFailed)
  let clock = 99
  assert.equal(await waitForExpiry(async () => clock++, 101, async () => {}, 3), 101)
  assert.equal(await waitForExpiry(async () => 102, 101, async () => {}, 1), 102)
  await assert.rejects(waitForExpiry(async () => 99, 101, async () => {}, 3), ExpectationFailed)
  await assert.rejects(waitForExpiry(async () => Number.NaN, 101, async () => {}, 1), ExpectationFailed)
  console.log('PASS self-test: loopback guards, exact balance and allowance deltas, delegate identity and revocation, hook rejection matching, missing-extra ledger errors, unchanged accounts and bounded Clock polling')
}

const stages = DEMO_ACCEPTANCE_MANIFEST.stageIds

async function main(): Promise<void> {
  if (process.argv.includes('--self-test')) return selfTest()
  console.log(`ACCEPTANCE_RUN ${JSON.stringify({ stages })}`)
  let current = 0
  const evidence = (data: Record<string, unknown>) => console.log(`EVIDENCE ${JSON.stringify(data, (_key, value) => typeof value === 'bigint' ? value.toString() : value)}`)
  const pass = () => { console.log(`PASS ${stages[current]}`); current += 1 }
  try {
    requireLoopback(RPC_URL, ['http:', 'https:'])
    requireLoopback(WS_URL, ['ws:', 'wss:'])
    await verifyLocalValidator()
    expect(existsSync(DEPLOYMENT_FILE), 'Missing deployment manifest; run localnet fixtures first')
    expect(existsSync(WALLETS_FILE), 'Missing synthetic wallets; run localnet fixtures first')
    const deployment = parseDeployment(loadDeployment())
    expect(deployment.cluster === 'localnet', 'Deployment must be localnet')
    expect(deployment.programs.aveoHook === AVEO_HOOK_PROGRAM_ID && deployment.programs.sas === SAS_PROGRAM_ID && deployment.programs.token2022 === TOKEN_2022_PROGRAM_ID, 'Unexpected deployment programs')
    const ctx = createApiContext({ cluster: 'localnet', rpcUrl: RPC_URL, commitment: 'confirmed', programId: deployment.programs.aveoHook, deployment })
    const backend = new AveoSasHookBackend(ctx)
    const assets = ['alfa', 'beta'].map((id) => {
      const asset = deployment.assets.find((item) => item.id === id)
      expect(asset, 'Missing required demo asset')
      return asset
    })
    expect(assets[0]!.mint !== assets[1]!.mint, 'Demo assets must use distinct mints')
    const wallet = (id: string) => {
      const found = deployment.wallets.find((item) => item.id === id)
      expect(found, 'Missing required demo wallet')
      return found
    }
    const treasury = wallet('treasury')
    const x = wallet('X')
    wallet('Y'); wallet('Z')
    const keys = await loadDevWallets()
    const signer = (id: string, expected: Address): KeyPairSigner => {
      const found = keys.get(id)?.signer
      expect(found?.address === expected, 'Fixture signer does not match public manifest')
      return found
    }
    const xSigner = signer('X', x.address)
    const treasurySigner = signer('treasury', treasury.address)
    // SEC-09 stays private: no normal Desk card or public fixture metadata needed.
    const missingSourceSigner = keys.get('missing-binding-source')?.signer
    expect(missingSourceSigner, 'Missing SEC-09 private synthetic source; regenerate localnet fixtures')
    expect(!deployment.wallets.some((entry) => entry.address === missingSourceSigner.address),
      'SEC-09 source must be separate from normal fixture wallets')
    const { value: programs } = await ctx.rpc.getMultipleAccounts([AVEO_HOOK_PROGRAM_ID, SAS_PROGRAM_ID, TOKEN_2022_PROGRAM_ID], { encoding: 'base64', commitment: 'confirmed' }).send()
    expect(programs.every((program) => program?.executable), 'Required programs are not executable on local validator')
    const checkedSend = async (payer: KeyPairSigner, instructions: Instruction[]) => {
      const signature = await send(payer, instructions, 1_000_000)
      const confirmation = await confirmSignature(ctx, signature)
      expect(confirmation.status === 'confirmed', 'Transaction did not confirm successfully')
      evidence({ signature, slot: confirmation.slot })
      return signature
    }
    const reject = async (payer: KeyPairSigner, instructions: Instruction[], expectedCode: ReasonCode) => {
      await verifyLocalValidator()
      const simulation = await simulate(ctx, instructions, payer.address)
      expect(!simulation.ok && simulation.error?.code === expectedCode, 'Simulation must reject with the expected hook code')
      expectHookRejection(simulation.logs, expectedCode)
      // Local acceptance only: record the expected failure in the ledger instead
      // of stopping at preflight. Production sending retains normal preflight.
      const { value: blockhash } = await ctx.rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
      const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(payer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
        (m) => appendTransactionMessageInstructions([getSetComputeUnitLimitInstruction({ units: 1_000_000 }), ...instructions], m),
      )
      const signed = await signTransactionMessageWithSigners(message)
      const signature = getSignatureFromTransaction(signed)
      await ctx.rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: 'base64', skipPreflight: true }).send()
      let confirmation = await confirmSignature(ctx, signature)
      // A processed failure can be visible before getTransaction exposes its
      // confirmed logs. Wait briefly for those logs, never accept a transport error.
      for (let attempt = 0; confirmation.status === 'failed' && confirmation.logs.length === 0 && attempt < 10; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 200))
        confirmation = await confirmSignature(ctx, signature)
      }
      expect(confirmation.status === 'failed' && confirmation.slot !== undefined, 'Expected a failed transaction recorded in the local ledger')
      expectHookRejection(confirmation.logs, expectedCode)
      evidence({ signature, slot: confirmation.slot, status: confirmation.status, hookCode: expectedCode })
      return confirmation
    }
    const rejectAccountMutation = async (payer: KeyPairSigner, instructions: Instruction[], expectedCode: ReasonCode, target: Address) => {
      const before = await readAccounts(ctx, [target])
      expect(before.accounts[0]?.owner === ctx.programId, 'Protected account must be owned by the hook program')
      await reject(payer, instructions, expectedCode)
      const after = await readAccounts(ctx, [target], before.slot)
      expectUnchangedAccount(before.accounts[0] ?? null, after.accounts[0] ?? null)
      evidence({ signer: payer.address, protectedAccount: target, hookCode: expectedCode, accountUnchanged: true, beforeSlot: before.slot, afterSlot: after.slot })
    }
    // Bind this report to the observed validator and loaded deployment, before
    // marking preconditions PASS. The environment pin is a check, not evidence.
    const actualGenesis = await ctx.rpc.getGenesisHash().send({ abortSignal: AbortSignal.timeout(10_000) })
    requireLocalGenesis(actualGenesis, process.env.AVEO_LOCAL_GENESIS_HASH)
    evidence({ genesisHash: actualGenesis, deploymentGeneratedAt: deployment.generatedAt })
    pass()

    const inspectX = () => Promise.all(assets.map((asset) => inspectEligibility(ctx, asset.mint, x.address)))
    const initial = await inspectX()
    for (const snapshot of initial) expectVerdict(snapshot)
    const sharedProof = initial[0]!.sourceAccounts.attestation
    expect(sharedProof && initial.every((snapshot) => snapshot.sourceAccounts.attestation === sharedProof), 'X must bind one shared proof across both assets')
    expect(initial.every((snapshot) => snapshot.proof?.kycPass && snapshot.proof.accreditedPass), 'X requires both eligibility facts')
    evidence({ wallet: x.address, sharedProof, mints: assets.map((asset) => asset.mint), slots: initial.map((snapshot) => snapshot.read.slot) })
    let scan = applyScan(EMPTY_STORE, initial, Math.max(...initial.map((snapshot) => snapshot.read.slot)), new Date().toISOString())
    pass()

    // Build and submit even negative transfers: a UI diagnostic alone is insufficient evidence.
    const transfer = async (asset: (typeof assets)[number], destination: Address, accepted: boolean, expectedCode?: ReasonCode, payer = treasurySigner) => {
      const before = (await tokenBalances(ctx, asset.mint, [payer.address, destination])).balances
      expect(before[0]! > 0n, 'Source must have tokens for a meaningful transfer')
      const instructions = await buildInstructions(ctx, { kind: 'transfer', mint: asset.mint, sourceOwner: payer.address, destinationOwner: destination, amount: 1n, decimals: asset.decimals }, payer)
      if (accepted) {
        const simulation = await simulate(ctx, instructions, payer.address)
        expect(simulation.ok, 'Expected successful hook simulation')
        await checkedSend(payer, instructions)
      } else {
        expect(expectedCode, 'Negative transfer requires an expected hook code')
        await reject(payer, instructions, expectedCode)
      }
      const readback = await tokenBalances(ctx, asset.mint, [payer.address, destination])
      expectBalances(before, readback.balances, accepted)
      evidence({ asset: asset.id, source: payer.address, destination, accepted, hookCode: expectedCode, before, after: readback.balances, slot: readback.slot })
    }
    for (const asset of assets) await transfer(asset, x.address, true)
    pass()

    // T11: an external wallet builds Token-2022 directly, without a Desk plan or builder.
    const externalTransfer = async (withExtras: boolean, expectedCode?: ReasonCode) => {
      await verifyLocalValidator()
      const asset = assets[0]!
      const before = (await tokenBalances(ctx, asset.mint, [treasury.address, x.address])).balances
      expect(before[0]! > 0n, 'External source must have tokens for a meaningful transfer')
      const [[source], [destination]] = await Promise.all([treasury.address, x.address].map((owner) => findAssociatedTokenPda({ owner, mint: asset.mint, tokenProgram: TOKEN_2022_PROGRAM_ID })))
      const raw = getTransferCheckedInstruction({ source, mint: asset.mint, destination, authority: treasurySigner, amount: 1n, decimals: asset.decimals })
      expect(raw.accounts.length === 4, 'Raw external transfer must contain only the four Token-2022 accounts')
      let instruction: Instruction = raw
      if (withExtras) {
        const extra = await resolveExtraAccountMetasForExecute({ rpc: ctx.rpc, transferHookProgramAddress: AVEO_HOOK_PROGRAM_ID, source, mint: asset.mint, destination, owner: treasury.address, amount: 1n })
        expect(extra.length > 0, 'Official client must resolve the required hook accounts')
        instruction = { ...raw, accounts: [...raw.accounts, ...extra] }
      }
      const accepted = withExtras && expectedCode === undefined
      const { value: blockhash } = await ctx.rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
      const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(treasurySigner, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
        (m) => appendTransactionMessageInstructions([getSetComputeUnitLimitInstruction({ units: 1_000_000 }), instruction], m),
      )
      const signed = await signTransactionMessageWithSigners(message)
      const signature = getSignatureFromTransaction(signed)
      await ctx.rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: 'base64', skipPreflight: !accepted, preflightCommitment: 'confirmed' }).send()
      let confirmation = await confirmSignature(ctx, signature)
      for (let attempt = 0; confirmation.status === 'failed' && confirmation.logs.length === 0 && attempt < 10; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 200))
        confirmation = await confirmSignature(ctx, signature)
      }
      expect(confirmation.status === (accepted ? 'confirmed' : 'failed') && confirmation.slot !== undefined, 'External transfer must have the expected ledger status and slot')
      if (!accepted) {
        expect(confirmation.error, 'Rejected external transfer must have a ledger error')
        if (expectedCode) {
          expect(confirmation.error.code === expectedCode, 'External transfer must fail with the expected hook code')
          expectHookRejection(confirmation.logs, expectedCode)
        } else {
          const { value: statuses } = await ctx.rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send()
          expect(statuses[0] && Number(statuses[0].slot) === confirmation.slot && ['confirmed', 'finalized'].includes(statuses[0].confirmationStatus ?? ''), 'Missing-extra failure must be recorded at a confirmed ledger slot')
          expectMissingExtraAccountsRejection(confirmation.status, confirmation.slot, statuses[0].err, confirmation.logs)
        }
      }
      const readback = await tokenBalances(ctx, asset.mint, [treasury.address, x.address])
      expect(readback.slot >= confirmation.slot, 'External balances must be read at or after the ledger transaction')
      expectBalances(before, readback.balances, accepted)
      evidence({ signature, slot: confirmation.slot, status: confirmation.status, hookCode: expectedCode })
      evidence({ asset: asset.id, source: treasury.address, destination: x.address, accepted, hookCode: expectedCode, before, after: readback.balances, slot: readback.slot })
    }
    await externalTransfer(true)
    pass()
    await externalTransfer(false)
    pass()

    const completeStage = (stage: string) => {
      expect(stages[current] === stage, 'Security acceptance stage order mismatch')
      pass()
    }
    await runAuthorizationChecks({ ctx, treasury: treasurySigner, x: xSigner, asset: assets[0]!, reject, emit: evidence, completeStage })
    await runBoundaryChecks({ ctx, treasurySigner, xSigner, walletX: x.address, asset: assets[0]!, loopbackAuthorized: true, evidence, passStage: completeStage })

    // T12: the delegate authorizes spending; X remains the compliance subject.
    const delegateSigner = (await newDevWallet('delegate', 'Synthetic delegate', 'investor')).signer
    expect(delegateSigner.address !== x.address && delegateSigner.address !== treasury.address, 'Delegate must be distinct from both token owners')
    const delegateBindings = await Promise.all(assets.map((asset) => findBindingPda(ctx.programId, asset.mint, delegateSigner.address)))
    const unbound = await readAccounts(ctx, delegateBindings)
    expect(unbound.accounts.every((account) => account === null), 'Fresh delegate must have no Aveo binding')
    expect((await findProofsForWallet(ctx, delegateSigner.address)).length === 0, 'Fresh delegate must have no SAS proof')
    const fundingSignature = await ctx.rpc.requestAirdrop(delegateSigner.address, lamports(100_000_000n), { commitment: 'confirmed' }).send()
    const funding = await confirmSignature(ctx, fundingSignature)
    expect(funding.status === 'confirmed' && funding.slot !== undefined, 'Delegate loopback airdrop must confirm')
    evidence({ signer: delegateSigner.address, signature: fundingSignature, slot: funding.slot })
    const delegatedAsset = assets[0]!
    const [[delegatedSource], [delegatedDestination]] = await Promise.all([x.address, treasury.address].map((owner) => findAssociatedTokenPda({ owner, mint: delegatedAsset.mint, tokenProgram: TOKEN_2022_PROGRAM_ID })))
    const readDelegatedAccounts = async (minContextSlot?: number) => {
      const readback = await readAccounts(ctx, [delegatedSource, delegatedDestination], minContextSlot)
      const tokens = readback.accounts.map((account, i) => {
        expect(account && account.owner === TOKEN_2022_PROGRAM_ID && !account.executable, 'Delegated transfer requires Token-2022 accounts')
        const token = getTokenDecoder().decode(account.data)
        expect(token.mint === delegatedAsset.mint && token.owner === [x.address, treasury.address][i], 'Delegated token account must have the actual mint and owner')
        return token
      })
      return { slot: readback.slot, source: tokens[0]!, balances: tokens.map((token) => token.amount) }
    }
    const beforeApproval = await readDelegatedAccounts()
    expectDelegation(beforeApproval.source, null, 0n)
    const delegatedTransfer = async (accepted: boolean) => {
      const ownerSnapshot = await inspectEligibility(ctx, delegatedAsset.mint, x.address)
      expectVerdict(ownerSnapshot, accepted ? undefined : 'AttestationExpired')
      const before = await readDelegatedAccounts(ownerSnapshot.read.slot)
      expectDelegation(before.source, delegateSigner.address, before.source.delegatedAmount)
      expect(before.source.amount > 0n && before.source.delegatedAmount > 0n, 'Delegated attempt must have spendable tokens and allowance')
      const raw = getTransferCheckedInstruction({ source: delegatedSource, mint: delegatedAsset.mint, destination: delegatedDestination, authority: delegateSigner, amount: 1n, decimals: delegatedAsset.decimals })
      expect(raw.accounts.length === 4, 'Raw delegated transfer must contain only the four Token-2022 accounts')
      const extra = await resolveExtraAccountMetasForExecute({ rpc: ctx.rpc, transferHookProgramAddress: AVEO_HOOK_PROGRAM_ID, source: delegatedSource, mint: delegatedAsset.mint, destination: delegatedDestination, owner: before.source.owner, amount: 1n })
      expect(extra.length > 0, 'Official client must resolve all delegated transfer hook accounts')
      const instruction: Instruction = { ...raw, accounts: [...raw.accounts, ...extra] }
      let transactionSlot: number
      if (accepted) {
        const signature = await checkedSend(delegateSigner, [instruction])
        const confirmation = await confirmSignature(ctx, signature)
        expect(confirmation.status === 'confirmed' && confirmation.slot !== undefined, 'Delegated transfer must confirm in the ledger')
        transactionSlot = confirmation.slot
      } else {
        const confirmation = await reject(delegateSigner, [instruction], 'AttestationExpired')
        expect(confirmation.slot !== undefined, 'Delegated hook rejection must have a ledger slot')
        transactionSlot = confirmation.slot
      }
      const after = await readDelegatedAccounts(transactionSlot)
      expectDelegatedTransfer(before.balances, after.balances, before.source.delegatedAmount, after.source.delegatedAmount, accepted)
      expectDelegation(after.source, delegateSigner.address, before.source.delegatedAmount - (accepted ? 1n : 0n))
      evidence({ asset: delegatedAsset.id, source: x.address, destination: treasury.address, signer: delegateSigner.address, proof: ownerSnapshot.sourceAccounts.attestation, accepted, hookCode: accepted ? undefined : 'AttestationExpired', before: before.balances, after: after.balances, delegatedAllowanceBefore: before.source.delegatedAmount, delegatedAllowanceAfter: after.source.delegatedAmount, slot: after.slot })
    }
    try {
      // Cover even an approval that reaches the ledger but fails confirmation/readback.
      const approvalSignature = await checkedSend(xSigner, [getApproveCheckedInstruction({ source: delegatedSource, mint: delegatedAsset.mint, delegate: delegateSigner.address, owner: xSigner, amount: 10n, decimals: delegatedAsset.decimals })])
      const approval = await confirmSignature(ctx, approvalSignature)
      expect(approval.status === 'confirmed' && approval.slot !== undefined, 'Owner approval must confirm in the ledger')
      const approved = await readDelegatedAccounts(approval.slot)
      expectDelegation(approved.source, delegateSigner.address, 10n)
      await delegatedTransfer(true)
      pass()

      for (const id of ['Y', 'Z']) {
        const owner = wallet(id).address
        const snapshots = await Promise.all(assets.map((asset) => inspectEligibility(ctx, asset.mint, owner)))
        const code = id === 'Y' ? 'ProviderPairNotAllowed' : 'RequiredFactMissing'
        expectVerdict(snapshots[0]!)
        expectVerdict(snapshots[1]!, code)
        const verifier = deployment.verifiers.find((item) => item.id === (id === 'Y' ? 'B' : 'A'))
        expect(verifier && snapshots.every((snapshot) => snapshot.sourceAccounts.credential === verifier.credential), 'Policy example must use the intended verifier')
        expect(snapshots[1]!.proof?.accreditedPass === false, 'Policy example must lack accreditation')
        await transfer(assets[0]!, owner, true)
        await transfer(assets[1]!, owner, false, code)
      }
      pass()

      const policyAddress = await findPolicyPda(ctx.programId, assets[0]!.mint)
      const { accounts: policyAccounts } = await readAccounts(ctx, [policyAddress])
      expect(policyAccounts[0], 'Policy account is required for issuer authorization test')
      const policy = decodeIssuerPolicy(policyAccounts[0].data)
      expect(policy.issuerAuthority !== xSigner.address, 'X must not be the issuer')
      const unauthorizedUpdate = await getUpdatePolicyInstruction({
        programId: ctx.programId, authority: xSigner, mint: assets[0]!.mint,
        args: { proofDomain: policy.proofDomain, pairs: policy.pairs, requireKyc: policy.requireKyc, requireAccredited: policy.requireAccredited, active: !policy.active },
      })
      await rejectAccountMutation(xSigner, [unauthorizedUpdate], 'UnauthorizedIssuer', policyAddress)
      pass()

      const y = wallet('Y')
      const ySigner = signer('Y', y.address)
      expect(y.address !== x.address, 'X and Y must be distinct subjects')
      const proofOfX = initial[0]!.proof
      expect(proofOfX, 'Live X proof is required for subject authorization test')
      const wrongSubjectBinding = await getSetBindingInstruction({
        programId: ctx.programId, subject: ySigner, mint: assets[0]!.mint,
        credential: proofOfX.credential, schema: proofOfX.schema, attestation: proofOfX.attestation,
      })
      await rejectAccountMutation(ySigner, [wrongSubjectBinding], 'SubjectMismatch', await findBindingPda(ctx.programId, assets[0]!.mint, y.address))
      pass()

      // T04 core only: a live, correctly signed SAS proof whose sole failing fact is KYC.
      const kycVerifier = deployment.verifiers.find((verifier) => verifier.id === 'A')
      expect(kycVerifier && initial.every((snapshot) => snapshot.proof?.credential === kycVerifier.credential
        && snapshot.proof.schema === kycVerifier.schema), 'Original X proof must belong to verifier A')
      const kycAuthority = signer('verifier-a', kycVerifier.authority)
      const kycPolicies = await readAccounts(ctx, await Promise.all(assets.map((asset) => findPolicyPda(ctx.programId, asset.mint))))
      expect(kycPolicies.accounts.every((account) => {
        if (account?.owner !== ctx.programId) return false
        const policy = decodeIssuerPolicy(account.data)
        return policy.active && policy.requireKyc
      }),
      'Both active policies must require KYC for the negative test')
      const kycNonce = (await newDevWallet('nonce', 'nonce', 'investor')).signer.address
      const [falseKycProof] = await deriveAttestationPda({ credential: kycVerifier.credential, schema: kycVerifier.schema, nonce: kycNonce })
      const clockRead = await readAccounts(ctx, [SYSVAR_CLOCK_ID])
      expect(clockRead.accounts[0], 'Validator Clock is required for false KYC proof')
      const kycClock = Number(getSysvarClockDecoder().decode(clockRead.accounts[0].data).unixTimestamp)
      expect(Number.isSafeInteger(kycClock) && kycClock >= 0, 'False KYC expiry needs a valid validator Clock')
      const kycBefore = await Promise.all(assets.map((asset) => tokenBalances(ctx, asset.mint, [treasury.address, x.address])))
      const setKycBindings = async (attestation: Address) => checkedSend(xSigner, await Promise.all(assets.map((asset) =>
        getSetBindingInstruction({ programId: ctx.programId, subject: xSigner, mint: asset.mint,
          credential: kycVerifier.credential, schema: kycVerifier.schema, attestation }))))
      let restoredKycSlot: number | undefined
      try {
        await checkedSend(kycAuthority, [getCreateAttestationInstruction({
          payer: kycAuthority as never, authority: kycAuthority as never, credential: kycVerifier.credential,
          schema: kycVerifier.schema, attestation: falseKycProof, nonce: kycNonce,
          data: encodeEligibilityPayload({ subjectWallet: x.address, proofDomain: hexToBytes(deployment.proofDomain),
            kycPass: false, accreditedPass: true }), expiry: kycClock + 86_400,
        }) as unknown as Instruction])
        const boundSignature = await setKycBindings(falseKycProof)
        const bound = await confirmSignature(ctx, boundSignature)
        expect(bound.status === 'confirmed' && bound.slot !== undefined, 'False KYC bindings must confirm')
        const blocked = await inspectX()
        requireFalseKycSnapshots({ ctx, snapshots: blocked, owner: x.address, proof: falseKycProof, assets, floor: bound.slot })
        expect(blocked.every((snapshot) => snapshot.proof?.credential === kycVerifier.credential
          && snapshot.proof.schema === kycVerifier.schema), 'False KYC proof must use the accepted verifier')
        evidence({ wallet: x.address, proof: falseKycProof, mints: assets.map((asset) => asset.mint),
          slots: blocked.map((snapshot) => snapshot.read.slot), verdicts: blocked.map((snapshot) => snapshot.verdict),
          hookCode: 'RequiredFactMissing', requiredFact: 'kyc', kycPass: false, accreditedPass: true })
        pass()
        for (const asset of assets) {
          await transfer(asset, x.address, false, 'RequiredFactMissing')
          await transfer(asset, treasury.address, false, 'RequiredFactMissing', xSigner)
        }
        pass()
      } finally {
        // Restore the original bindings before closing the temporary SAS proof.
        const signature = await setKycBindings(address(sharedProof))
        const restored = await confirmSignature(ctx, signature)
        expect(restored.status === 'confirmed' && restored.slot !== undefined, 'Original KYC bindings must confirm after the test')
        restoredKycSlot = restored.slot
        for (const snapshot of await inspectX()) {
          expectVerdict(snapshot)
          expect(snapshot.sourceAccounts.attestation === sharedProof && snapshot.read.slot >= restored.slot,
            'Original KYC proof must be eligible again at a fresh slot')
        }
        const temporary = await readAccounts(ctx, [falseKycProof], restored.slot)
        if (temporary.accounts[0]) {
          expect(temporary.accounts[0].owner === SAS_PROGRAM_ID, 'Temporary KYC proof must be SAS-owned')
          await checkedSend(kycAuthority, [getCloseAttestationInstruction({ payer: kycAuthority as never,
            authority: kycAuthority as never, credential: kycVerifier.credential, attestation: falseKycProof }) as unknown as Instruction])
        }
        expect((await readAccounts(ctx, [falseKycProof], restored.slot)).accounts[0] === null,
          'Temporary false KYC proof must be closed')
      }
      for (const [index, asset] of assets.entries()) {
        const after = await tokenBalances(ctx, asset.mint, [treasury.address, x.address])
        expectBalances(kycBefore[index]!.balances, after.balances, false)
        evidence({ asset: asset.id, before: kycBefore[index]!.balances, after: after.balances, slot: after.slot })
      }
      evidence({ wallet: x.address, proof: sharedProof, closedProof: falseKycProof, slot: restoredKycSlot })
      pass()

      const proofs = await findProofsForWallet(ctx, x.address)
      expect(proofs.some((proof) => proof.address === sharedProof), 'Shared proof must be present before close')
      for (const proof of proofs) {
        const verifier = deployment.verifiers.find((item) => item.credential === proof.attestation.credential)
        expect(verifier, 'Cannot close a proof from an unknown verifier')
        const authority = signer(`verifier-${verifier.id.toLowerCase()}`, verifier.authority)
        await checkedSend(authority, [getCloseAttestationInstruction({ payer: authority as never, authority: authority as never, credential: proof.attestation.credential, attestation: proof.address }) as unknown as Instruction])
        evidence({ closedProof: proof.address })
      }
      expect((await findProofsForWallet(ctx, x.address)).length === 0, 'All X proofs must be closed')
      const closed = await inspectX()
      for (const snapshot of closed) expectVerdict(snapshot, 'AttestationMissingOrClosed')
      pass()

      for (const asset of assets) {
        await transfer(asset, x.address, false, 'AttestationMissingOrClosed')
        await transfer(asset, treasury.address, false, 'AttestationMissingOrClosed', xSigner)
      }
      pass()

      scan = applyScan(scan, closed, Math.max(...closed.map((snapshot) => snapshot.read.slot)), new Date().toISOString())
      const grouped = scan.incidents.filter((incident) => incident.wallet === x.address && incident.type === 'PROOF_CLOSED')
      expect(grouped.length === 1 && grouped[0]!.proof === sharedProof, 'Closed shared proof must create one incident')
      expect(grouped[0]!.affectedMints.length === 2 && assets.every((asset) => grouped[0]!.affectedMints.includes(asset.mint)), 'Incident must group both assets')
      const repeated = applyScan(scan, closed, Math.max(...closed.map((snapshot) => snapshot.read.slot)), new Date().toISOString())
      expect(repeated.incidents.length === scan.incidents.length, 'Repeated scan must not duplicate incidents')
      evidence({ incidentType: grouped[0]!.type, proof: sharedProof, affectedMints: grouped[0]!.affectedMints })
      pass()

      // Persist the actual closed-proof incident, not fabricated prior eligibility.
      await checkIncidentPersistence(scan, closed, evidence, (stage) => {
        expect(stages[current] === stage, 'Persistence stage order must match the acceptance report')
        pass()
      })

      const verifierA = deployment.verifiers.find((verifier) => verifier.id === 'A')
      expect(verifierA, 'Missing verifier A')
      const authority = signer('verifier-a', verifierA.authority)
      const nonce = (await newDevWallet('nonce', 'nonce', 'investor')).signer.address
      const [renewal] = await deriveAttestationPda({ credential: verifierA.credential, schema: verifierA.schema, nonce })
      const clock = closed[0]!.clockUnix
      expect(clock !== undefined, 'Validator clock is required for renewal expiry')
      await checkedSend(authority, [getCreateAttestationInstruction({
        payer: authority as never, authority: authority as never, credential: verifierA.credential, schema: verifierA.schema,
        attestation: renewal, nonce,
        data: encodeEligibilityPayload({ subjectWallet: x.address, proofDomain: hexToBytes(deployment.proofDomain), kycPass: true, accreditedPass: true }),
        expiry: clock + 86_400,
      }) as unknown as Instruction])
      expect((await findProofsForWallet(ctx, x.address)).some((proof) => proof.address === renewal), 'Renewal must be discoverable')
      for (const snapshot of await inspectX()) expectVerdict(snapshot, 'AttestationMissingOrClosed')
      evidence({ renewal, wallet: x.address })
      pass()

      const plan = await backend.planRenewBinding({ cluster: 'localnet', mint: assets[0]!.mint, mints: assets.map((asset) => asset.mint), wallet: x.address, attestation: renewal })
      expect(plan.simulation.ok && !plan.blocked, 'Batched rebind plan must simulate successfully')
      expect(plan.requiredSigners.length === 1 && plan.requiredSigners[0] === x.address, 'X must be the single required signer')
      expect(plan.request.kind === 'set-binding' && plan.request.mints.length === 2, 'Plan must contain both asset bindings')
      const instructions = await buildInstructions(ctx, plan.request, xSigner)
      expect(instructions.length === 2, 'One binding instruction is required per asset')
      const signature = await checkedSend(xSigner, instructions)
      pass()

      const verified = await backend.verifyOutcome({ cluster: 'localnet', signature, plan })
      expect(verified.status === 'confirmed' && verified.slot !== undefined, 'Backend must confirm batched rebind')
      expect(verified.readback?.length === 2, 'Backend must read back both assets')
      const fresh = await inspectX()
      for (const snapshot of [...verified.readback!, ...fresh]) {
        expectVerdict(snapshot)
        expect(snapshot.sourceAccounts.attestation === renewal && snapshot.proof?.attestation === renewal, 'Fresh binding must reference renewal')
        expect(snapshot.read.slot >= verified.slot, 'Readback must be at or after transaction confirmation')
      }
      expect(applyVerification(grouped[0]!, fresh, new Date().toISOString()).state === 'resolved', 'Fresh readback must resolve the grouped incident')
      evidence({ signature, renewal, slots: fresh.map((snapshot) => snapshot.read.slot), verdicts: fresh.map((snapshot) => snapshot.verdict) })
      pass()

      for (const asset of assets) {
        await transfer(asset, x.address, true)
        await transfer(asset, treasury.address, true, undefined, xSigner)
      }
      pass()

      // T08/T17 change Alfa only. Restore every original argument even when a check fails.
      const issuerSigner = signer('issuer', deployment.issuer)
      const alfa = assets[0]!
      const beta = assets[1]!
      const originalRead = await readAccounts(ctx, [policyAddress, await findPolicyPda(ctx.programId, beta.mint)])
      expect(originalRead.accounts[0] && originalRead.accounts[1], 'Both policies must exist before issuer tests')
      const originalPolicy = decodeIssuerPolicy(originalRead.accounts[0].data)
      expect(originalPolicy.issuerAuthority === issuerSigner.address, 'Fixture issuer must own Alfa policy')
      const originalArgs: PolicyArgs = {
        proofDomain: originalPolicy.proofDomain, pairs: originalPolicy.pairs,
        requireKyc: originalPolicy.requireKyc, requireAccredited: originalPolicy.requireAccredited, active: originalPolicy.active,
      }
      const betaBefore = originalRead.accounts[1]
      const updateAlfa = async (args: PolicyArgs) => {
        await checkedSend(issuerSigner, [await getUpdatePolicyInstruction({ programId: ctx.programId, authority: issuerSigner, mint: alfa.mint, args })])
        const readback = await readAccounts(ctx, [policyAddress, betaBefore.address], originalRead.slot)
        expect(readback.accounts[0], 'Updated Alfa policy must exist')
        const updated = decodeIssuerPolicy(readback.accounts[0].data)
        expect(bytesEqual(updated.proofDomain, args.proofDomain) && updated.requireKyc === args.requireKyc && updated.requireAccredited === args.requireAccredited && updated.active === args.active, 'Policy arguments must match issuer update')
        expect(updated.pairs.length === args.pairs.length && updated.pairs.every((pair, i) => pair.credential === args.pairs[i]!.credential && pair.schema === args.pairs[i]!.schema), 'Policy pairs must match issuer update')
        expect(updated.policyVersion > originalPolicy.policyVersion, 'Issuer update must advance policy version')
        expectUnchangedAccount(betaBefore, readback.accounts[1] ?? null)
        evidence({ asset: alfa.id, protectedAccount: policyAddress, policyVersion: updated.policyVersion, policyActive: updated.active, slot: readback.slot })
      }
      const restoredAlfa = async () => {
        for (const snapshot of await inspectX()) expectVerdict(snapshot)
        for (const asset of assets) {
          await transfer(asset, x.address, true)
          await transfer(asset, treasury.address, true, undefined, xSigner)
        }
      }
      const withoutA = originalArgs.pairs.filter((pair) => pair.credential !== verifierA.credential)
      expect(withoutA.length > 0 && withoutA.length < originalArgs.pairs.length, 'T08 requires A and another provider in Alfa')
      try {
        await updateAlfa({ ...originalArgs, pairs: withoutA })
        const removed = await inspectX()
        expectVerdict(removed[0]!, 'ProviderPairNotAllowed')
        expectVerdict(removed[1]!)
        const providerScan = applyScan(applyScan(EMPTY_STORE, fresh, verified.slot, new Date().toISOString()), removed, Math.max(...removed.map((snapshot) => snapshot.read.slot)), new Date().toISOString())
        const incident = providerScan.incidents.filter((item) => item.wallet === x.address && item.type === 'PROVIDER_REMOVED')
        expect(incident.length === 1 && incident[0]!.affectedMints.length === 1 && incident[0]!.affectedMints[0] === alfa.mint, 'T08 incident must affect Alfa only')
        evidence({ incidentType: incident[0]!.type, wallet: x.address, proof: renewal, affectedMints: incident[0]!.affectedMints })
        await transfer(alfa, x.address, false, 'ProviderPairNotAllowed')
        await transfer(alfa, treasury.address, false, 'ProviderPairNotAllowed', xSigner)
        await transfer(beta, x.address, true)
        await transfer(beta, treasury.address, true, undefined, xSigner)
        pass()
      } finally {
        await updateAlfa(originalArgs)
      }
      await restoredAlfa()
      pass()

      try {
        await updateAlfa({ ...originalArgs, active: false })
        const inactive = await inspectX()
        expectVerdict(inactive[0]!, 'PolicyMissingOrInactive')
        expectVerdict(inactive[1]!)
        await transfer(alfa, x.address, false, 'PolicyMissingOrInactive')
        await transfer(alfa, treasury.address, false, 'PolicyMissingOrInactive', xSigner)
        await transfer(beta, x.address, true)
        await transfer(beta, treasury.address, true, undefined, xSigner)
        pass()
      } finally {
        await updateAlfa(originalArgs)
      }
      await restoredAlfa()
      pass()

      const readClock = async () => {
        const { value } = await ctx.rpc.getAccountInfo(SYSVAR_CLOCK_ID, { encoding: 'base64', commitment: 'confirmed' }).send({ abortSignal: AbortSignal.timeout(2_000) })
        expect(value, 'Validator Clock account must exist')
        return Number(getSysvarClockDecoder().decode(new Uint8Array(getBase64Encoder().encode(value.data[0]))).unixTimestamp)
      }
      const bindX = async (attestation: Address) => {
        const bindingPlan = await backend.planRenewBinding({ cluster: 'localnet', mint: alfa.mint, mints: assets.map((asset) => asset.mint), wallet: x.address, attestation })
        expect(bindingPlan.simulation.ok && !bindingPlan.blocked && bindingPlan.requiredSigners.length === 1 && bindingPlan.requiredSigners[0] === x.address, 'X batched binding must simulate and require only X')
        const signature = await checkedSend(xSigner, await buildInstructions(ctx, bindingPlan.request, xSigner))
        const outcome = await backend.verifyOutcome({ cluster: 'localnet', signature, plan: bindingPlan })
        expect(outcome.status === 'confirmed' && outcome.slot !== undefined && outcome.readback?.length === 2, 'X batched binding must confirm with both readbacks')
        for (const snapshot of outcome.readback) {
          expectVerdict(snapshot)
          expect(snapshot.sourceAccounts.attestation === attestation && snapshot.read.slot >= outcome.slot, 'Bindings must reference requested proof at a fresh slot')
        }
        evidence({ wallet: x.address, proof: attestation, signature, slot: outcome.slot, mints: assets.map((asset) => asset.mint) })
      }
      const shortNonce = (await newDevWallet('nonce', 'nonce', 'investor')).signer.address
      const [shortProof] = await deriveAttestationPda({ credential: verifierA.credential, schema: verifierA.schema, nonce: shortNonce })
      const expiry = (await readClock()) + 30
      try {
        await checkedSend(authority, [getCreateAttestationInstruction({
          payer: authority as never, authority: authority as never, credential: verifierA.credential, schema: verifierA.schema,
          attestation: shortProof, nonce: shortNonce,
          data: encodeEligibilityPayload({ subjectWallet: x.address, proofDomain: hexToBytes(deployment.proofDomain), kycPass: true, accreditedPass: true }), expiry,
        }) as unknown as Instruction])
        await bindX(shortProof)
        const liveClock = await readClock()
        expect(liveClock < expiry, 'Short proof must still be live after both bindings confirm')
        evidence({ wallet: x.address, proof: shortProof, expiry, clockUnix: liveClock })
        pass()

        const expiredClock = await waitForExpiry(readClock, expiry, async () => { await new Promise((resolve) => setTimeout(resolve, 500)) })
        evidence({ wallet: x.address, proof: shortProof, expiry, clockUnix: expiredClock })
        pass()

        const expired = await inspectX()
        for (const snapshot of expired) {
          expectVerdict(snapshot, 'AttestationExpired')
          expect(snapshot.clockUnix !== undefined && snapshot.clockUnix >= expiry && snapshot.sourceAccounts.attestation === shortProof, 'Expired snapshot must use validator Clock and short proof')
        }
        for (const asset of assets) {
          await transfer(asset, x.address, false, 'AttestationExpired')
          await transfer(asset, treasury.address, false, 'AttestationExpired', xSigner)
        }
        pass()
        await externalTransfer(true, 'AttestationExpired')
        pass()
        await delegatedTransfer(false)
        pass()
      } finally {
        // A failed expiry test must not strand the demo with expired bindings.
        await bindX(renewal)
      }
      for (const asset of assets) {
        await transfer(asset, x.address, true)
        await transfer(asset, treasury.address, true, undefined, xSigner)
      }
      pass()
    } finally {
      // Only X, the token account owner, can remove the temporary approval.
      const signature = await checkedSend(xSigner, [getRevokeInstruction({ source: delegatedSource, owner: xSigner })])
      const confirmation = await confirmSignature(ctx, signature)
      expect(confirmation.status === 'confirmed' && confirmation.slot !== undefined, 'Owner revocation must confirm in the ledger')
      const after = await readDelegatedAccounts(confirmation.slot)
      expectDelegation(after.source, null, 0n)
      evidence({ asset: delegatedAsset.id, source: x.address, signer: x.address, delegatedAllowanceAfter: after.source.delegatedAmount, slot: after.slot })
    }
    pass()
    const verifier = deployment.verifiers.find((entry) => entry.id === 'A')
    expect(verifier, 'Verifier A required for adversarial acceptance')
    const adversarial: AdversarialContext = {
      ctx, deployment, assets, x: xSigner, treasury: treasurySigner,
      issuer: signer('issuer', deployment.issuer), verifier: signer('verifier-a', verifier.authority),
      nonce: async () => (await newDevWallet('nonce', 'nonce', 'investor')).signer.address,
      send: checkedSend, reject, transfer, emit: evidence,
      complete: (stage) => { expect(stages[current] === stage, 'Unexpected adversarial stage order'); pass() },
    }
    await runSchemaValidityChecks(adversarial)
    await runSasAdversarialChecks(adversarial)
    const missingBindingInput: MissingBindingChecksInput = { ...adversarial,
      rejectMissingBinding: async (payer, instructions): Promise<MissingBindingRejection> => {
        await verifyLocalValidator()
        const genesis = await ctx.rpc.getGenesisHash().send()
        expect(genesis === actualGenesis, 'Validator genesis changed since acceptance startup')
        const { value: blockhash } = await ctx.rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
        const message = pipe(
          createTransactionMessage({ version: 0 }),
          (m) => setTransactionMessageFeePayerSigner(payer, m),
          (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
          (m) => appendTransactionMessageInstructions([getSetComputeUnitLimitInstruction({ units: 1_000_000 }), ...instructions], m),
        )
        const signed = await signTransactionMessageWithSigners(message)
        const signature = getSignatureFromTransaction(signed)
        // Deliberately persist the negative transaction on the isolated ledger.
        // This bypass is never used by the application or public deployment tooling.
        await ctx.rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: 'base64', skipPreflight: true }).send()
        let confirmation = await confirmSignature(ctx, signature)
        for (let attempt = 0; confirmation.status === 'failed' && confirmation.logs.length === 0 && attempt < 10; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 200))
          confirmation = await confirmSignature(ctx, signature)
        }
        expect(confirmation.status === 'failed' && confirmation.slot !== undefined && confirmation.logs.length > 0,
          'Missing binding transfer must fail with confirmed ledger logs')
        const { value: statuses } = await ctx.rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send()
        expect(statuses[0] && Number(statuses[0].slot) === confirmation.slot
          && ['confirmed', 'finalized'].includes(statuses[0].confirmationStatus ?? '') && statuses[0].err,
        'Missing binding rejection must have a confirmed raw ledger error')
        return { signature, status: 'failed', slot: confirmation.slot, logs: confirmation.logs, err: statuses[0].err }
      },
    }
    await runMissingBindingChecks(missingBindingInput)
    await runMissingSourceBindingChecks({ ...missingBindingInput, sourceSigner: missingSourceSigner,
      guardLocalnet: async () => {
        requireLoopback(RPC_URL, ['http:', 'https:'])
        requireLoopback(WS_URL, ['ws:', 'wss:'])
        await verifyLocalValidator()
        expect(await ctx.rpc.getGenesisHash().send() === actualGenesis, 'Validator genesis changed since acceptance startup')
      },
    })
    console.log(`PASS demo-check (${stages.length}/${stages.length})`)
  } catch (error) {
    // Never serialize wallet records, error objects, endpoint URLs or raw RPC logs.
    const detail = error instanceof ExpectationFailed ? error.message : 'Execution failed; check local validator and fixture prerequisites'
    console.log(`FAIL ${stages[current] ?? 'demo-check'}: ${detail}`)
    for (const stage of stages.slice(current + 1)) console.log(`NOT_RUN ${stage}`)
    process.exitCode = 1
  }
}

main().catch(() => {
  console.log('FAIL demo-check: unexpected runner error')
  process.exitCode = 1
})
