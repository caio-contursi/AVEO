import assert from 'node:assert/strict'
import { AccountRole, isAddress, isSignature, type Address, type Signature } from '@solana/kit'
import {
  findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getTokenDecoder, getMintDecoder,
  getTransferCheckedInstruction, resolveExtraAccountMetasForExecute,
} from '@solana-program/token-2022'
import { readAccounts, type RawAccount } from '../src/api/accounts'
import { decodeEligibilityBinding } from '../src/api/codecs'
import { AVEO_HOOK_PROGRAM_ID, SAS_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '../src/api/constants'
import { onchainReasonFromLogs } from '../src/api/errors'
import { findBindingPda, findExtraAccountMetasPda, findPolicyPda } from '../src/api/pdas'
import type { AdversarialContext } from './adversarial-context'
import { inspectEligibility } from '../src/api/eligibility'

// Only T04's absent-binding branch; missing proof and false KYC remain separate cases.
export const MISSING_BINDING_STAGES = [
  'missing-binding-atas-created', 'missing-binding-transfers-rejected',
  'missing-binding-protected-accounts-unchanged',
] as const

export const MISSING_SOURCE_BINDING_STAGES = [
  'missing-source-binding-preconditions', 'missing-source-binding-transfers-rejected',
  'missing-source-binding-protected-accounts-unchanged',
] as const

export interface MissingSourceBindingChecksInput extends MissingBindingChecksInput {
  sourceSigner: AdversarialContext['treasury']
  /** Parent checks loopback endpoints and the genesis pinned at runner startup. */
  guardLocalnet: () => Promise<void>
}

/** Called after issuance/revocation, before any initial fixture transfers. */
export function requireMissingSourceFixtureAccounting(asset: AdversarialContext['assets'][number],
  accounts: (RawAccount | null)[], owners: Address[], atas: Address[]): void {
  assert(owners.length === 5 && new Set(owners).size === 5 && atas.length === 5
    && new Set(atas).size === 5 && accounts.length === 6, 'Five distinct synthetic holders required')
  const mintRaw = accounts[0]
  assert(mintRaw && mintRaw.address === asset.mint && mintRaw.owner === TOKEN_2022_PROGRAM_ID && !mintRaw.executable,
    'Valid fixture mint required')
  const mint = getMintDecoder().decode(mintRaw.data)
  assert(mint.supply === 1001n && mint.mintAuthority.__option === 'None' && mint.isInitialized
    && mint.decimals === asset.decimals, 'Fixture supply must be 1001 with revoked mint authority')
  accounts.slice(1).forEach((raw, i) => {
    assert(raw && raw.address === atas[i] && raw.owner === TOKEN_2022_PROGRAM_ID && !raw.executable, 'Valid fixture token account required')
    const token = getTokenDecoder().decode(raw.data)
    assert(token.mint === asset.mint && token.owner === owners[i] && token.state === 1
      && token.amount === (i === 0 ? 1000n : i === 4 ? 1n : 0n), 'Fixture balance accounting must remain 1000/0/0/0/1')
  })
}

// spl-tlv-account-resolution 0.10.0: IncorrectAccount=2_724_315_840, AccountDataTooSmall=base+15.
export const MISSING_BINDING_TLV_ERROR = 2_724_315_855

export interface MissingBindingRejection {
  signature: Signature
  status: 'failed'
  slot: number
  logs: string[]
  /** Raw ledger TransactionError, not the Desk's translated DiagnosticReason. */
  err: unknown
}

export interface MissingBindingChecksInput extends AdversarialContext {
  /**
   * Submit the supplied single TransferChecked (preceded by exactly one compute-budget
   * instruction), confirm it, and return its raw error and confirmed transaction logs.
   * A client resolver failure or simulation alone must throw, never return a ledger result.
   */
  rejectMissingBinding: (payer: AdversarialContext['treasury'],
    instructions: Parameters<AdversarialContext['send']>[1]) => Promise<MissingBindingRejection>
}

/** Synthetic localnet only; the parent owns validator identity pinning and signing. */
export async function runMissingBindingChecks(input: MissingBindingChecksInput): Promise<void> {
  const { ctx, deployment, assets, treasury, x, emit, complete } = input
  const endpoint = new URL(ctx.rpcUrl)
  assert(ctx.cluster === 'localnet' && deployment.cluster === 'localnet'
    && ['confirmed', 'finalized'].includes(ctx.commitment)
    && ['http:', 'https:'].includes(endpoint.protocol)
    && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
    && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash && endpoint.pathname === '/',
  'Missing binding checks require confirmed synthetic localnet')
  assert.equal(ctx.programId, AVEO_HOOK_PROGRAM_ID)
  assert.equal(deployment.programs.aveoHook, AVEO_HOOK_PROGRAM_ID)
  assert.equal(deployment.programs.sas, SAS_PROGRAM_ID)
  assert.equal(deployment.programs.token2022, TOKEN_2022_PROGRAM_ID)
  assert(assets.length === 2 && new Set(assets.map((asset) => asset.mint)).size === 2, 'Both distinct assets required')
  assert.notEqual(treasury.address, x.address)
  assert.equal(typeof input.rejectMissingBinding, 'function', 'Raw ledger rejection callback required')

  const owner = await input.nonce()
  assert(isAddress(owner) && ![x.address, treasury.address, input.issuer.address, input.verifier.address,
    ...assets.map((asset) => asset.mint), ...deployment.verifiers.map((entry) => entry.authority)].includes(owner),
  'Nonce must identify a fresh destination owner')
  let floor = 0
  const read = async (addresses: Address[]) => {
    const result = await readAccounts(ctx, addresses, floor)
    assert(Number.isSafeInteger(result.slot) && result.slot >= floor, 'Invalid or stale account observation slot')
    assert.equal(result.accounts.length, addresses.length)
    floor = result.slot
    return result.accounts
  }
  const required = (raw: RawAccount | null | undefined, address: Address, program: Address) => {
    assert(raw && raw.address === address && raw.owner === program && !raw.executable, 'Missing or invalid protected account')
    return raw
  }
  const unchanged = (before: RawAccount, after: RawAccount | null | undefined) => {
    assert(after, 'Protected account disappeared')
    assert.deepEqual(after, before, 'Missing binding check changed a protected account')
  }
  const confirmedStatus = async (signature: Signature) => {
    assert(isSignature(signature), 'Valid ledger signature required')
    const { value } = await ctx.rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send()
    const status = value[0]
    assert(status && ['confirmed', 'finalized'].includes(status.confirmationStatus ?? ''), 'Confirmed ledger status required')
    const slot = Number(status.slot)
    assert(Number.isSafeInteger(slot) && slot >= 0, 'Invalid confirmation slot')
    floor = Math.max(floor, slot)
    return { status, slot }
  }
  const fixtures = await Promise.all(assets.map(async (asset) => {
    const assetId = asset.id
    assert(assetId === 'alfa' || assetId === 'beta', 'Only the two approved fixture assets are supported')
    const [source, destination, sourceBinding, missingBinding, fallbackBinding, policy, validation] = await Promise.all([
      findAssociatedTokenPda({ owner: treasury.address, mint: asset.mint, tokenProgram: TOKEN_2022_PROGRAM_ID }).then(([a]) => a),
      findAssociatedTokenPda({ owner, mint: asset.mint, tokenProgram: TOKEN_2022_PROGRAM_ID }).then(([a]) => a),
      findBindingPda(ctx.programId, asset.mint, treasury.address), findBindingPda(ctx.programId, asset.mint, owner),
      findBindingPda(ctx.programId, asset.mint, x.address), findPolicyPda(ctx.programId, asset.mint),
      findExtraAccountMetasPda(ctx.programId, asset.mint),
    ])
    return { asset, assetId: assetId as 'alfa' | 'beta', source, destination, sourceBinding, missingBinding, fallbackBinding, policy, validation }
  }))
  const absentAddresses = [owner, ...fixtures.flatMap((f) => [f.destination, f.missingBinding])]
  assert((await read(absentAddresses)).every((raw) => raw === null), 'Destination owner, ATAs and bindings must be absent')
  const bindingAddresses = fixtures.flatMap((f) => [f.sourceBinding, f.fallbackBinding])
  const bindingRaw = await read(bindingAddresses)
  const bindings = bindingRaw.map((raw, i) => {
    const binding = decodeEligibilityBinding(required(raw, bindingAddresses[i]!, ctx.programId).data)
    assert(binding.version === 2 && binding.mint === assets[Math.floor(i / 2)]!.mint
      && binding.subjectWallet === (i % 2 ? x.address : treasury.address), 'Fixture binding subject/mint/version mismatch')
    return binding
  })
  const protectedAddresses = [...new Set([
    ...fixtures.flatMap((f) => [f.asset.mint, f.source, f.policy, f.validation]), ...bindingAddresses,
    ...bindings.flatMap((b) => [b.credential, b.schema, b.attestation]),
  ])]
  assert(!protectedAddresses.includes(treasury.address), 'Fee payer cannot be a protected account')
  const original = await read(protectedAddresses)
  const originals = original.map((raw, i) => {
    const address = protectedAddresses[i]!
    const token = fixtures.some((f) => f.asset.mint === address || f.source === address)
    const sas = bindings.some((b) => [b.credential, b.schema, b.attestation].includes(address))
    return required(raw, address, token ? TOKEN_2022_PROGRAM_ID : sas ? SAS_PROGRAM_ID : ctx.programId)
  })
  bindingAddresses.forEach((address, i) => unchanged(bindingRaw[i]!, original[protectedAddresses.indexOf(address)]))
  const amounts = (f: typeof fixtures[number], raws: (RawAccount | null)[]) => [f.source, f.destination].map((address, i) => {
    const state = getTokenDecoder().decode(required(raws[i], address, TOKEN_2022_PROGRAM_ID).data)
    assert(state.mint === f.asset.mint && state.owner === (i ? owner : treasury.address), 'Token mint/owner mismatch')
    return state.amount
  })
  const failures: unknown[] = []
  let destinationOriginals: RawAccount[] | undefined
  try {
    const signature = await input.send(treasury, fixtures.map((f) => getCreateAssociatedTokenIdempotentInstruction({
      payer: treasury, ata: f.destination, owner, mint: f.asset.mint, tokenProgram: TOKEN_2022_PROGRAM_ID,
    })))
    assert.equal((await confirmedStatus(signature)).status.err, null, 'ATA creation failed in ledger')
    const destinations = await read(fixtures.map((f) => f.destination))
    destinationOriginals = destinations.map((raw, i) => required(raw, fixtures[i]!.destination, TOKEN_2022_PROGRAM_ID))
    for (const f of fixtures) {
      const before = amounts(f, await read([f.source, f.destination]))
      assert(before[0]! > 0n && before[1] === 0n, 'Funded source and empty destination required')
    }
    assert((await read(fixtures.map((f) => f.missingBinding))).every((raw) => raw === null), 'Fresh destination binding must remain absent')
    for (const f of fixtures) {
      await assert.rejects(() => resolveExtraAccountMetasForExecute({ rpc: ctx.rpc,
        transferHookProgramAddress: ctx.programId, source: f.source, mint: f.asset.mint,
        destination: f.destination, owner: treasury.address, amount: 1n }),
      (error: unknown) => error instanceof Error && error.message ===
        `Invalid transfer hook pubkey data: account ${f.missingBinding} was not found.`,
      'Official resolver must fail specifically on the absent destination binding')
    }
    assert((await read(fixtures.map((f) => f.missingBinding))).every((raw) => raw === null), 'Resolver readback must confirm binding absence')
    emit({ signature, slot: floor, status: 'confirmed', wallet: owner, mints: assets.map((a) => a.mint) })
    complete(MISSING_BINDING_STAGES[0])

    for (const [i, f] of fixtures.entries()) {
      const before = amounts(f, await read([f.source, f.destination]))
      const source = bindings[i * 2]!, fallback = bindings[i * 2 + 1]!
      // programs/aveo-hook/src/extra_metas.rs order. No resolver is used: absent binding
      // data cannot yield destination SAS keys. X's real SAS accounts merely fill those
      // later metas; they are never represented as a proof/binding for the fresh owner.
      const extra = [f.policy, f.sourceBinding, f.missingBinding,
        source.credential, source.schema, source.attestation,
        fallback.credential, fallback.schema, fallback.attestation, ctx.programId, f.validation]
        .map((address) => ({ address, role: AccountRole.READONLY }))
      const raw = getTransferCheckedInstruction({ source: f.source, mint: f.asset.mint,
        destination: f.destination, authority: treasury, amount: 1n, decimals: f.asset.decimals })
      const result = await input.rejectMissingBinding(treasury, [{ ...raw, accounts: [...raw.accounts, ...extra] }])
      assert(result && result.status === 'failed' && Number.isSafeInteger(result.slot) && result.slot >= 0
        && Array.isArray(result.logs) && result.logs.length > 0
        && result.logs.every((line) => typeof line === 'string' && line.length > 0), 'Confirmed failed ledger observation required')
      const confirmation = await confirmedStatus(result.signature)
      assert.equal(confirmation.slot, result.slot, 'Rejection slot mismatch')
      assert(confirmation.status.err !== null, 'Ledger unexpectedly accepted missing binding transfer')
      assert.deepEqual(result.err, confirmation.status.err, 'Raw rejection error mismatch')
      assert(result.err && typeof result.err === 'object' && 'InstructionError' in result.err, 'Raw ledger instruction error required')
      const error = result.err.InstructionError
      assert(Array.isArray(error) && error.length === 2 && [1, 1n].includes(error[0])
        && error[1] && typeof error[1] === 'object' && 'Custom' in error[1], 'Expected transfer custom instruction error')
      const hookFailed = result.logs.some((line) => line.startsWith(`Program ${ctx.programId} failed:`))
      if (hookFailed) {
        assert(onchainReasonFromLogs(result.logs, ctx.programId)?.code === 'BindingMissing'
          && Number(error[1].Custom) === 6003, 'Hook must reject with BindingMissing')
      } else {
        assert(!result.logs.some((line) => line.startsWith(`Program ${ctx.programId} invoke`))
          && Number(error[1].Custom) === MISSING_BINDING_TLV_ERROR
          && result.logs.includes(`Program ${TOKEN_2022_PROGRAM_ID} failed: custom program error: 0x${MISSING_BINDING_TLV_ERROR.toString(16)}`),
        'Expected Token-2022 TLV AccountDataTooSmall before hook CPI')
      }
      const after = amounts(f, await read([f.source, f.destination]))
      assert.deepEqual(after, before, 'Rejected transfer changed balances')
      assert.equal((await read([f.missingBinding]))[0], null, 'Destination binding must remain absent')
      emit({ signature: result.signature, status: 'failed', slot: result.slot,
        ...(hookFailed ? { hookCode: 'BindingMissing' as const } : {}) })
      emit({ asset: f.assetId, source: treasury.address, destination: owner, accepted: false,
        before: before.map(String), after: after.map(String), slot: floor })
    }
    complete(MISSING_BINDING_STAGES[1])
  } catch (error) { failures.push(error) } finally {
    // Observe fixture integrity even after a post-send callback or reporting failure.
    // Fresh empty ATAs remain on localnet: closing them would require a new owner signer.
    try {
      const after = await read(protectedAddresses)
      originals.forEach((raw, i) => unchanged(raw, after[i]))
      assert((await read(fixtures.map((f) => f.missingBinding))).every((raw) => raw === null), 'Destination binding must remain absent')
      if (destinationOriginals) {
        const destinations = await read(fixtures.map((f) => f.destination))
        destinationOriginals.forEach((raw, i) => unchanged(raw, destinations[i]))
      }
    } catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, 'Missing binding checks or protected readback failed')
  for (const protectedAccount of [...protectedAddresses, ...fixtures.map((f) => f.destination)]) {
    emit({ protectedAccount, slot: floor, accountUnchanged: true })
  }
  complete(MISSING_BINDING_STAGES[2])
}

/** SEC-09's absent SOURCE binding branch only; never claims full T04 coverage. */
export async function runMissingSourceBindingChecks(input: MissingSourceBindingChecksInput): Promise<void> {
  const { ctx, deployment, assets, sourceSigner, treasury, emit, complete } = input
  const endpoint = new URL(ctx.rpcUrl)
  assert(ctx.cluster === 'localnet' && deployment.cluster === 'localnet'
    && ['confirmed', 'finalized'].includes(ctx.commitment)
    && ['http:', 'https:'].includes(endpoint.protocol)
    && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
    && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash && endpoint.pathname === '/',
  'Missing source binding checks require confirmed synthetic localnet')
  assert.equal(ctx.programId, AVEO_HOOK_PROGRAM_ID)
  assert.equal(deployment.programs.aveoHook, AVEO_HOOK_PROGRAM_ID)
  assert.equal(deployment.programs.sas, SAS_PROGRAM_ID)
  assert.equal(deployment.programs.token2022, TOKEN_2022_PROGRAM_ID)
  assert.equal(typeof input.guardLocalnet, 'function', 'Pinned genesis guard required')
  assert.equal(typeof input.rejectMissingBinding, 'function', 'Raw ledger rejection callback required')
  assert(assets.length === 2 && new Set(assets.map((asset) => asset.id)).size === 2
    && assets.every((asset) => ['alfa', 'beta'].includes(asset.id))
    && new Set(assets.map((asset) => asset.mint)).size === 2, 'Both distinct assets required')
  assert(isAddress(sourceSigner.address) && ![treasury.address, input.x.address, input.issuer.address,
    input.verifier.address, ...deployment.verifiers.map((v) => v.authority), ...assets.map((a) => a.mint)]
    .includes(sourceSigner.address), 'Separate synthetic source signer required')
  await input.guardLocalnet()
  let floor = 0
  const read = async (addresses: Address[]) => {
    const result = await readAccounts(ctx, addresses, floor)
    assert(Number.isSafeInteger(result.slot) && result.slot >= floor, 'Invalid or stale account observation slot')
    assert.equal(result.accounts.length, addresses.length)
    floor = result.slot
    return result.accounts
  }
  const required = (raw: RawAccount | null | undefined, address: Address, program: Address) => {
    assert(raw && raw.address === address && raw.owner === program && !raw.executable, 'Missing or invalid protected account')
    return raw
  }
  const fixtures = await Promise.all(assets.map(async (asset) => {
    const [source, destination, missing, binding, policy, validation] = await Promise.all([
      findAssociatedTokenPda({ owner: sourceSigner.address, mint: asset.mint, tokenProgram: TOKEN_2022_PROGRAM_ID }).then(([a]) => a),
      findAssociatedTokenPda({ owner: treasury.address, mint: asset.mint, tokenProgram: TOKEN_2022_PROGRAM_ID }).then(([a]) => a),
      findBindingPda(ctx.programId, asset.mint, sourceSigner.address), findBindingPda(ctx.programId, asset.mint, treasury.address),
      findPolicyPda(ctx.programId, asset.mint), findExtraAccountMetasPda(ctx.programId, asset.mint),
    ])
    return { asset, source, destination, missing, binding, policy, validation }
  }))
  const bindingRaw = await read(fixtures.map((f) => f.binding))
  const boundFixtures = fixtures.map((f, i) => {
    const proof = decodeEligibilityBinding(required(bindingRaw[i], f.binding, ctx.programId).data)
    assert(proof.version === 2 && proof.mint === f.asset.mint && proof.subjectWallet === treasury.address,
      'Destination binding subject/mint/version mismatch')
    return { ...f, proof }
  })
  // A single coherent byte snapshot protects both token balances and every decision account.
  const protectedPrograms = new Map<Address, Address>()
  for (const f of boundFixtures) {
    for (const address of [f.source, f.destination, f.asset.mint]) protectedPrograms.set(address, TOKEN_2022_PROGRAM_ID)
    for (const address of [f.binding, f.policy, f.validation]) protectedPrograms.set(address, ctx.programId)
    for (const address of [f.proof.credential, f.proof.schema, f.proof.attestation]) protectedPrograms.set(address, SAS_PROGRAM_ID)
  }
  const addresses = [...protectedPrograms.keys()]
  assert(!addresses.includes(sourceSigner.address), 'Fee payer cannot be protected')
  const original = (await read(addresses)).map((raw, i) => required(raw, addresses[i]!, protectedPrograms.get(addresses[i]!)!))
  for (const [i, f] of boundFixtures.entries()) {
    assert.deepEqual(original[addresses.indexOf(f.binding)], bindingRaw[i], 'Destination binding changed during setup')
    const mint = getMintDecoder().decode(original[addresses.indexOf(f.asset.mint)]!.data)
    assert(mint.supply === 1001n && mint.mintAuthority.__option === 'None'
      && mint.isInitialized && mint.decimals === f.asset.decimals, 'SEC-09 requires supply 1001 and revoked mint authority')
  }
  const balances = async (f: typeof fixtures[number]) => (await read([f.source, f.destination])).map((raw, i) => {
    const token = getTokenDecoder().decode(required(raw, i ? f.destination : f.source, TOKEN_2022_PROGRAM_ID).data)
    assert(token.mint === f.asset.mint && token.owner === (i ? treasury.address : sourceSigner.address)
      && token.state === 1, 'Token mint/owner/state mismatch')
    return token.amount
  })
  const absent = async () => assert((await read(fixtures.map((f) => f.missing))).every((raw) => raw === null),
    'Exact source binding PDA must be absent')
  const eligible = async (f: typeof boundFixtures[number]) => {
    const snapshot = await inspectEligibility(ctx, f.asset.mint, treasury.address)
    assert(snapshot.verdict === 'eligible' && !snapshot.reasons.some((r) => !r.hint)
      && snapshot.mint === f.asset.mint && snapshot.wallet === treasury.address
      && snapshot.sourceAccounts.policy === f.policy && snapshot.sourceAccounts.binding === f.binding
      && snapshot.sourceAccounts.credential === f.proof.credential && snapshot.sourceAccounts.schema === f.proof.schema
      && snapshot.sourceAccounts.attestation === f.proof.attestation
      && Number.isSafeInteger(snapshot.read.slot) && snapshot.read.slot >= floor,
    'Fresh valid destination binding/proof and active policy required')
    floor = snapshot.read.slot
  }
  const failures: unknown[] = []
  try {
    await absent()
    for (const f of boundFixtures) {
      assert((await balances(f))[0]! > 0n, 'Positive source balance required')
      await eligible(f)
      await assert.rejects(() => resolveExtraAccountMetasForExecute({ rpc: ctx.rpc,
        transferHookProgramAddress: ctx.programId, source: f.source, mint: f.asset.mint,
        destination: f.destination, owner: sourceSigner.address, amount: 1n }),
      (error: unknown) => error instanceof Error && error.message ===
        `Invalid transfer hook pubkey data: account ${f.missing} was not found.`,
      'Official resolver must fail specifically on the absent source binding')
    }
    await absent()
    complete(MISSING_SOURCE_BINDING_STAGES[0])
    for (const f of boundFixtures) {
      const before = await balances(f)
      assert(before[0]! > 0n, 'Positive source balance required')
      await eligible(f)
      await absent()
      // Missing source data cannot resolve SAS keys. Destination's real proof fills
      // the later source metas solely to reach the absent-binding rejection layer.
      const sas = [f.proof.credential, f.proof.schema, f.proof.attestation]
      const extra = [f.policy, f.missing, f.binding, ...sas, ...sas, ctx.programId, f.validation]
        .map((address) => ({ address, role: AccountRole.READONLY }))
      const raw = getTransferCheckedInstruction({ source: f.source, mint: f.asset.mint,
        destination: f.destination, authority: sourceSigner, amount: 1n, decimals: f.asset.decimals })
      await input.guardLocalnet()
      const result = await input.rejectMissingBinding(sourceSigner, [{ ...raw, accounts: [...raw.accounts, ...extra] }])
      assert(result && result.status === 'failed' && isSignature(result.signature)
        && Number.isSafeInteger(result.slot) && result.slot >= floor && Array.isArray(result.logs)
        && result.logs.length > 0 && result.logs.every((line) => typeof line === 'string' && line.length > 0),
      'Confirmed failed ledger observation required')
      // Advance before further validation so even a mismatched callback triggers fresh integrity reads.
      floor = result.slot
      const { value } = await ctx.rpc.getSignatureStatuses([result.signature], { searchTransactionHistory: true }).send()
      const status = value[0]
      assert(status && ['confirmed', 'finalized'].includes(status.confirmationStatus ?? '')
        && Number(status.slot) === result.slot && status.err, 'Matching confirmed rejection required')
      assert.deepEqual(status.err, result.err, 'Raw rejection error mismatch')
      const transaction = await ctx.rpc.getTransaction(result.signature, { encoding: 'json',
        maxSupportedTransactionVersion: 0, commitment: ctx.commitment === 'finalized' ? 'finalized' : 'confirmed' }).send()
      assert(transaction && Number(transaction.slot) === result.slot
        && transaction.transaction.signatures[0] === result.signature, 'Matching confirmed transaction required')
      assert.deepEqual(transaction.meta?.err, result.err, 'Confirmed transaction error mismatch')
      assert.deepEqual(transaction.meta?.logMessages, result.logs, 'Confirmed transaction logs mismatch')
      assert(result.err && typeof result.err === 'object' && 'InstructionError' in result.err, 'Raw instruction error required')
      const error = result.err.InstructionError
      assert(Array.isArray(error) && error.length === 2 && [1, 1n].includes(error[0])
        && error[1] && typeof error[1] === 'object' && 'Custom' in error[1], 'Expected transfer custom instruction error')
      const hookFailed = result.logs.some((line) => line.startsWith(`Program ${ctx.programId} failed:`))
      if (hookFailed) {
        assert(Number(error[1].Custom) === 6003 && onchainReasonFromLogs(result.logs, ctx.programId)?.code === 'BindingMissing'
          && result.logs.includes(`Program ${ctx.programId} failed: custom program error: 0x1773`), 'Hook must reject with BindingMissing')
      } else {
        assert(Number(error[1].Custom) === MISSING_BINDING_TLV_ERROR
          && !result.logs.some((line) => line.startsWith(`Program ${ctx.programId} invoke`))
          && result.logs.includes(`Program ${TOKEN_2022_PROGRAM_ID} failed: custom program error: 0x${MISSING_BINDING_TLV_ERROR.toString(16)}`),
        'Expected Token-2022 TLV AccountDataTooSmall before hook CPI')
      }
      const after = await balances(f)
      assert.deepEqual(after, before, 'Rejected transfer changed balances')
      await absent()
      emit({ signature: result.signature, status: 'failed', slot: result.slot,
        ...(hookFailed ? { hookCode: 'BindingMissing' as const } : {}) })
      emit({ asset: f.asset.id as 'alfa' | 'beta', source: sourceSigner.address, destination: treasury.address,
        accepted: false, before: before.map(String), after: after.map(String), slot: floor })
    }
    complete(MISSING_SOURCE_BINDING_STAGES[1])
  } catch (error) { failures.push(error) } finally {
    try {
      const after = await read(addresses)
      original.forEach((raw, i) => assert.deepEqual(after[i], raw, 'Missing source binding check changed a protected account'))
      await absent()
    } catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, 'Missing source binding checks or protected readback failed')
  for (const protectedAccount of addresses) emit({ protectedAccount, slot: floor, accountUnchanged: true })
  complete(MISSING_SOURCE_BINDING_STAGES[2])
}
