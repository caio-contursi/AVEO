import assert from 'node:assert/strict'
import type { Address, Instruction, KeyPairSigner, Signature } from '@solana/kit'
import { getSysvarClockDecoder } from '@solana/sysvars'
import {
  deriveAttestationPda, getChangeSchemaStatusInstruction, getCloseAttestationInstruction,
  getCreateAttestationInstruction,
} from 'sas-lib'
import { readAccounts, type RawAccount } from '../src/api/accounts'
import {
  decodeEligibilityBinding, decodeSasAttestation, decodeSasCredential, decodeSasSchema,
  encodeEligibilityPayload, isAveoEligibilityV2,
} from '../src/api/codecs'
import { SAS_PROGRAM_ID, SYSVAR_CLOCK_ID } from '../src/api/constants'
import { getSetBindingInstruction } from '../src/api/instructions'
import { findBindingPda, findPolicyPda } from '../src/api/pdas'
import { hexToBytes } from '../src/config/deployment'
import type { AdversarialContext } from './adversarial-context'

// Exact transaction-Clock equality is deliberately absent: unit coverage is not ledger evidence.
// The parent must keep the equality portion of T17 partial/NOT_RUN.
export const SCHEMA_VALIDITY_STAGES = [
  'schema-paused', 'schema-paused-transfers-rejected', 'schema-authorized-unpause-readback',
  'expiry-zero-bindings-rejected', 'expiry-live-proof-bound', 'expiry-strictly-expired-rejected',
  'schema-validity-originals-restored',
] as const

/** Mirrors Aveo's strict expiry > Clock rule, including SAS's otherwise unbounded expiry=0. */
export function proofIsLive(expiry: bigint, clock: bigint): boolean {
  return expiry > clock
}

export async function runSchemaValidityChecks(input: AdversarialContext): Promise<void> {
  const { ctx, deployment, assets, x, treasury, verifier, send, reject, transfer, emit, complete } = input
  const endpoint = new URL(ctx.rpcUrl)
  assert(ctx.cluster === 'localnet' && deployment.cluster === 'localnet'
    && ['confirmed', 'finalized'].includes(ctx.commitment)
    && ['http:', 'https:'].includes(endpoint.protocol)
    && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
    && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash && endpoint.pathname === '/',
  'Schema validity checks require confirmed synthetic localnet')
  assert.equal(ctx.programId, deployment.programs.aveoHook)
  assert.equal(deployment.programs.sas, SAS_PROGRAM_ID)
  assert(assets.length === 2 && new Set(assets.map((asset) => asset.mint)).size === 2, 'Both distinct assets required')
  const bindingAddresses = await Promise.all(assets.map((asset) => findBindingPda(ctx.programId, asset.mint, x.address)))
  const policyAddresses = await Promise.all(assets.map((asset) => findPolicyPda(ctx.programId, asset.mint)))
  let floor = 0
  const read = async (addresses: Address[]) => {
    const result = await readAccounts(ctx, addresses, floor)
    floor = result.slot
    return result.accounts
  }
  const required = (raw: RawAccount | null | undefined, owner: Address): RawAccount => {
    assert(raw && raw.owner === owner && !raw.executable, 'Missing or invalid protected account')
    return raw
  }
  const originalBindings = (await read(bindingAddresses)).map((raw) => required(raw, ctx.programId))
  const bindings = originalBindings.map((raw, i) => {
    const binding = decodeEligibilityBinding(raw.data)
    assert(binding.subjectWallet === x.address && binding.mint === assets[i]!.mint, 'Binding subject/mint mismatch')
    return binding
  })
  const { credential, schema } = bindings[0]!
  assert(bindings.every((binding) => binding.credential === credential && binding.schema === schema),
    'Both X bindings must use the shared schema')
  const provider = deployment.verifiers.find((entry) => entry.credential === credential && entry.schema === schema)
  assert(provider && provider.authority === verifier.address, 'Shared schema authority must be the delegated verifier')
  const [credentialRaw, schemaRaw, ...policyRaw] = await read([credential, schema, ...policyAddresses])
  const originalCredential = required(credentialRaw, SAS_PROGRAM_ID)
  const originalSchema = required(schemaRaw, SAS_PROGRAM_ID)
  const originalPolicies = policyRaw.map((raw) => required(raw, ctx.programId))
  const credentialState = decodeSasCredential(originalCredential.data)
  const schemaState = decodeSasSchema(originalSchema.data)
  assert(credentialState.authority === verifier.address && credentialState.authorizedSigners.includes(verifier.address),
    'Verifier must own credential and be an authorized attestation signer')
  assert(schemaState.credential === credential && !schemaState.isPaused && isAveoEligibilityV2(schemaState),
    'A live Aveo schema is required before testing')
  const unchanged = (before: RawAccount, after: RawAccount | null | undefined) => {
    assert(after, 'Protected account disappeared')
    assert.equal(after.owner, before.owner)
    assert.equal(after.executable, before.executable)
    assert.equal(after.lamports, before.lamports)
    assert.deepEqual(after.data, before.data, 'Protected configuration or binding changed')
  }
  const confirmedSend = async (payer: KeyPairSigner, instructions: Instruction[]): Promise<Signature> => {
    const signature = await send(payer, instructions)
    const { value } = await ctx.rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send()
    const status = value[0]
    assert(status && status.err === null && ['confirmed', 'finalized'].includes(status.confirmationStatus ?? ''),
      'Parent send must return a confirmed successful ledger signature')
    const slot = Number(status.slot)
    assert(Number.isSafeInteger(slot) && slot >= 0, 'Invalid confirmation slot')
    floor = Math.max(floor, slot)
    return signature
  }
  // sas-lib 1.0.10 uses kit 5 signer types; the parent uses kit 8. Runtime signer shape is shared.
  const statusInstruction = (isPaused: boolean) => getChangeSchemaStatusInstruction({
    authority: verifier as never, credential, schema, isPaused,
  }) as unknown as Instruction
  const bind = (index: number, attestation: Address, pair = bindings[index]!) => getSetBindingInstruction({
    programId: ctx.programId, subject: x, mint: assets[index]!.mint,
    credential: pair.credential, schema: pair.schema, attestation,
  })
  const rejectBinding = async (index: number, proof: Address, before: RawAccount) => {
    const result = await reject(x, [await bind(index, proof)], 'AttestationExpired')
    // Parent verifies confirmation and the exact hook code; require its ledger observation before readback.
    assert(result && typeof result === 'object' && 'status' in result && result.status === 'failed'
      && 'slot' in result && typeof result.slot === 'number' && Number.isSafeInteger(result.slot) && result.slot >= 0
      && 'logs' in result && Array.isArray(result.logs) && result.logs.length > 0
      && result.logs.every((line: unknown) => typeof line === 'string' && line.length > 0),
    'Expected confirmed failed ledger observation with valid slot and logs')
    floor = Math.max(floor, result.slot)
    unchanged(before, (await read([bindingAddresses[index]!]))[0])
  }
  const clock = async () => {
    const [raw] = await read([SYSVAR_CLOCK_ID])
    assert(raw && !raw.executable, 'Live RPC Clock required')
    const unix = getSysvarClockDecoder().decode(raw.data).unixTimestamp
    assert(unix >= 0n && unix <= BigInt(Number.MAX_SAFE_INTEGER), 'Invalid validator Clock')
    return unix
  }
  const checkSchema = async (paused: boolean) => {
    const [raw] = await read([schema])
    const current = required(raw, SAS_PROGRAM_ID)
    assert.equal(decodeSasSchema(current.data).isPaused, paused, 'Fresh schema status mismatch')
    if (!paused) unchanged(originalSchema, current)
    emit({ protectedAccount: schema, slot: floor, schemaPaused: paused, accountUnchanged: !paused })
  }
  const bothDirections = async () => {
    for (const asset of assets) {
      await transfer(asset, x.address, false, 'SchemaMismatchOrPaused')
      await transfer(asset, treasury.address, false, 'SchemaMismatchOrPaused', x)
    }
  }
  const created: Address[] = []
  let schemaAttempted = false
  let bindingAttempted = false
  const failures: unknown[] = []
  const createProof = async (expiry: bigint) => {
    const nonce = await input.nonce()
    const [proof] = await deriveAttestationPda({ credential, schema, nonce })
    assert.equal((await read([proof]))[0], null, 'Nonce must identify a new proof')
    // Track before send: a callback/confirmation failure can follow an actual successful creation.
    created.push(proof)
    const signature = await confirmedSend(verifier, [getCreateAttestationInstruction({
      payer: verifier as never, authority: verifier as never, credential, schema, attestation: proof, nonce,
      data: encodeEligibilityPayload({ subjectWallet: x.address, proofDomain: hexToBytes(deployment.proofDomain),
        kycPass: true, accreditedPass: true }), expiry,
    }) as unknown as Instruction])
    const [raw] = await read([proof])
    const state = decodeSasAttestation(required(raw, SAS_PROGRAM_ID).data)
    assert(state.nonce === nonce && state.credential === credential && state.schema === schema
      && state.signer === verifier.address && state.expiry === expiry, 'Fresh SAS proof mismatch')
    emit({ signature, slot: floor, status: 'confirmed', proof, expiry: Number(expiry) })
    return proof
  }
  try {
    schemaAttempted = true
    await confirmedSend(verifier, [statusInstruction(true)])
    await checkSchema(true)
    complete(SCHEMA_VALIDITY_STAGES[0])
    await bothDirections()
    complete(SCHEMA_VALIDITY_STAGES[1])
    await confirmedSend(verifier, [statusInstruction(false)])
    await checkSchema(false)
    complete(SCHEMA_VALIDITY_STAGES[2])

    const zeroProof = await createProof(0n)
    assert(!proofIsLive(0n, await clock()), 'Zero expiry must be invalid under Aveo')
    for (let i = 0; i < assets.length; i += 1) {
      await rejectBinding(i, zeroProof, originalBindings[i]!)
    }
    complete(SCHEMA_VALIDITY_STAGES[3])

    const expiry = (await clock()) + 30n
    const shortProof = await createProof(expiry)
    bindingAttempted = true
    await confirmedSend(x, await Promise.all(assets.map((_, i) => bind(i, shortProof))))
    const bound = await read(bindingAddresses)
    bound.forEach((raw) => assert.equal(decodeEligibilityBinding(required(raw, ctx.programId).data).attestation, shortProof))
    const liveClock = await clock()
    assert(proofIsLive(expiry, liveClock), 'Proof expired before live binding readback')
    emit({ proof: shortProof, expiry: Number(expiry), clockUnix: Number(liveClock), slot: floor })
    complete(SCHEMA_VALIDITY_STAGES[4])

    let expiredClock = await clock()
    for (let poll = 0; expiredClock <= expiry && poll < 120; poll += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      expiredClock = await clock()
    }
    assert(expiredClock > expiry && !proofIsLive(expiry, expiredClock), 'Clock never became strictly later than expiry')
    emit({ proof: shortProof, expiry: Number(expiry), clockUnix: Number(expiredClock), slot: floor })
    for (let i = 0; i < assets.length; i += 1) {
      await rejectBinding(i, shortProof, required(bound[i], ctx.programId))
      const asset = assets[i]!
      await transfer(asset, x.address, false, 'AttestationExpired')
      await transfer(asset, treasury.address, false, 'AttestationExpired', x)
    }
    complete(SCHEMA_VALIDITY_STAGES[5])
  } catch (error) { failures.push(error) } finally {
    // Attempt independent restorations even when another cleanup or reporting callback fails.
    if (schemaAttempted) {
      try {
        await confirmedSend(verifier, [statusInstruction(schemaState.isPaused)])
        unchanged(originalSchema, (await read([schema]))[0])
      } catch (error) { failures.push(error) }
    }
    if (bindingAttempted) {
      for (let i = 0; i < assets.length; i += 1) {
        try {
          await confirmedSend(x, [await bind(i, bindings[i]!.attestation)])
          unchanged(originalBindings[i]!, (await read([bindingAddresses[i]!]))[0])
        } catch (error) { failures.push(error) }
      }
    }
    // Never close a proof still referenced by an unrestored fixture binding.
    let safeToClose = false
    try {
      const restored = await read(bindingAddresses)
      restored.forEach((raw, i) => unchanged(originalBindings[i]!, raw))
      safeToClose = true
    } catch (error) { failures.push(error) }
    if (safeToClose) {
      for (const proof of created) {
        try {
          if ((await read([proof]))[0] === null) continue
          await confirmedSend(verifier, [getCloseAttestationInstruction({
            payer: verifier as never, authority: verifier as never, credential, attestation: proof,
          }) as unknown as Instruction])
          assert.equal((await read([proof]))[0], null, 'Temporary proof not closed')
        } catch (error) { failures.push(error) }
      }
    }
    try {
      const restored = await read([schema, credential, ...policyAddresses])
      const originals = [originalSchema, originalCredential, ...originalPolicies]
      originals.forEach((raw, i) => unchanged(raw, restored[i]))
    } catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, 'Schema validity checks or fixture restoration failed')
  emit({ wallet: x.address, protectedAccount: schema, mints: assets.map((asset) => asset.mint), slot: floor, accountUnchanged: true })
  complete(SCHEMA_VALIDITY_STAGES[6])
}
