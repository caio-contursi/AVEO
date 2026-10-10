import assert from 'node:assert/strict'
import { type Address, type Instruction } from '@solana/kit'
import { findAssociatedTokenPda, getTokenDecoder } from '@solana-program/token-2022'
import {
  deriveAttestationPda, getChangeAuthorizedSignersInstruction, getCreateAttestationInstruction,
} from 'sas-lib'
import { readAccounts, type AccountsRead, type RawAccount } from '../src/api/accounts'
import {
  bytesEqual, decodeEligibilityBinding, decodeSasAttestation, decodeSasCredential, decodeSasSchema,
  isAveoEligibilityV2,
} from '../src/api/codecs'
import { SAS_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '../src/api/constants'
import { getSetBindingInstruction } from '../src/api/instructions'
import { findBindingPda, findExtraAccountMetasPda, findPolicyPda } from '../src/api/pdas'
import type { OnchainError } from '@aveo/contracts'
import type { AdversarialContext } from './adversarial-context'

export const SAS_ADVERSARIAL_STAGES = [
  'sas-malformed-payloads-rejected',
  'sas-unauthorized-signer-binding-rejected',
  'sas-revoked-signer-transfers-rejected',
  'sas-original-fixtures-restored',
] as const

// These stages are partial T10 coverage, never a full matrix PASS by themselves.
export const SAS_ADVERSARIAL_COVERAGE_GAPS = [
  'Corrupted canonical SAS envelopes cannot be created through the supported SAS SDK lifecycle; no account forging is used.',
  'False-owner substitutions and incompatible SAS schemas are not exercised by this first slice; T10 remains NOT_RUN.',
  'Auxiliary SAS attestations remain on the synthetic local ledger; original accounts are preserved.',
  'Truncated payload issuance is rejected by SAS before an Aveo binding exists; it is not a malformed-proof hook test.',
] as const

/** Dependencies are reads/builders only. The parent retains all transaction submission authority. */
export const sasAdversarialDependencies = {
  readAccounts, findAssociatedTokenPda, findBindingPda, findPolicyPda, findExtraAccountMetasPda,
  getSetBindingInstruction, deriveAttestationPda, getCreateAttestationInstruction,
  getChangeAuthorizedSignersInstruction,
}
export type SasAdversarialDependencies = typeof sasAdversarialDependencies

export function expectSasAccountUnchanged(before: RawAccount | null, after: RawAccount | null): void {
  assert(before && after, 'Protected SAS acceptance account must exist')
  assert(before.address === after.address && before.owner === after.owner && before.lamports === after.lamports
    && before.executable === after.executable && bytesEqual(before.data, after.data),
  'Rejected SAS operation changed a protected account')
}

export function expectSasSignerSet(actual: readonly Address[], expected: readonly Address[]): void {
  assert.deepEqual(actual, expected, 'Credential signer list must match the observed original order')
}

/** No SDK exception or simulation result is sufficient. Parent reject must return its confirmed ledger observation. */
export function requireSasLedgerFailure(result: unknown): { slot: number; logs: string[] } {
  assert(result && typeof result === 'object' && 'status' in result && result.status === 'failed'
    && 'slot' in result && typeof result.slot === 'number' && Number.isSafeInteger(result.slot) && result.slot >= 0
    && 'logs' in result && Array.isArray(result.logs) && result.logs.length > 0
    && result.logs.every((line: unknown) => typeof line === 'string'), 'Expected confirmed failed ledger observation with logs')
  return { slot: result.slot, logs: result.logs as string[] }
}

/** Preserve SAS's schema length so the real lifecycle can reach Aveo's boolean validation. */
export function malformedSasEligibilityPayloads(data: Uint8Array): readonly Uint8Array[] {
  assert.equal(data.length, 75, 'Expected original 75-byte Aveo eligibility payload')
  const invalidBoolean = data.slice()
  invalidBoolean[73] = 2
  return [invalidBoolean]
}

/** Invoked only by the guarded parent with synthetic localnet keys. No global lib/RPC imports. */
export async function runSasAdversarialChecks(input: AdversarialContext): Promise<void> {
  return runSasAdversarialChecksWithDependencies(input, sasAdversarialDependencies)
}

export async function runSasAdversarialChecksWithDependencies(
  input: AdversarialContext, deps: SasAdversarialDependencies,
): Promise<void> {
  const { ctx, x, treasury, verifier, assets } = input
  assert.equal(ctx.cluster, 'localnet', 'Synthetic localnet context required')
  assert(ctx.commitment === 'confirmed' || ctx.commitment === 'finalized', 'Confirmed account reads required')
  assert(assets.length > 0 && new Set(assets.map((asset) => asset.mint)).size === assets.length, 'Distinct assets required')
  assert.equal(new Set([x.address, treasury.address, verifier.address, input.issuer.address]).size, 4, 'Distinct synthetic signers required')

  const bindings = await Promise.all(assets.flatMap((asset) => [x, treasury].map(async (subject) => {
    const address = await deps.findBindingPda(ctx.programId, asset.mint, subject.address)
    const read = await deps.readAccounts(ctx, [address])
    const raw = read.accounts[0]
    assert(raw?.owner === ctx.programId, 'Existing binding must belong to the hook')
    const binding = decodeEligibilityBinding(raw.data)
    assert(binding.mint === asset.mint && binding.subjectWallet === subject.address, 'Binding fixture identity mismatch')
    return { asset, subject, address, binding }
  })))
  const original = bindings[0]!.binding
  assert(bindings.every(({ binding }) => binding.credential === original.credential && binding.schema === original.schema),
    'This adversarial fixture requires a shared provider for X and treasury')
  const tokenAddresses = await Promise.all(assets.flatMap((asset) => [x, treasury].map(async (subject) =>
    (await deps.findAssociatedTokenPda({ owner: subject.address, mint: asset.mint, tokenProgram: TOKEN_2022_PROGRAM_ID }))[0])))
  const policyAddresses = await Promise.all(assets.map((asset) => deps.findPolicyPda(ctx.programId, asset.mint)))
  const validationAddresses = await Promise.all(assets.map((asset) => deps.findExtraAccountMetasPda(ctx.programId, asset.mint)))
  const protectedAddresses = [...new Set([
    ...bindings.map(({ address }) => address), ...policyAddresses, ...validationAddresses,
    ...assets.map(({ mint }) => mint), ...tokenAddresses, original.credential, original.schema,
    ...bindings.map(({ binding }) => binding.attestation),
  ])]
  assert(!protectedAddresses.includes(input.issuer.address), 'Fee payer must not be protected')
  const initial = await deps.readAccounts(ctx, protectedAddresses)
  const rawAt = (read: AccountsRead, address: Address): RawAccount => {
    const raw = read.accounts[protectedAddresses.indexOf(address)]
    assert(raw, 'Missing protected fixture account')
    return raw
  }
  const credentialRaw = rawAt(initial, original.credential)
  const schemaRaw = rawAt(initial, original.schema)
  assert(credentialRaw.owner === SAS_PROGRAM_ID && schemaRaw.owner === SAS_PROGRAM_ID, 'Official SAS ownership required')
  const credential = decodeSasCredential(credentialRaw.data)
  const schema = decodeSasSchema(schemaRaw.data)
  assert.equal(credential.authority, verifier.address, 'Parent verifier must control the original credential')
  assert(credential.authorizedSigners.includes(verifier.address) && !credential.authorizedSigners.includes(x.address), 'Expected authorized verifier and unauthorized X')
  assert(!schema.isPaused && isAveoEligibilityV2(schema), 'Original schema must be active Aveo eligibility v2')
  const proofRaw = rawAt(initial, original.attestation)
  assert.equal(proofRaw.owner, SAS_PROGRAM_ID, 'Original proof must belong to SAS')
  const proof = decodeSasAttestation(proofRaw.data)
  assert(bindings.every(({ binding }) => {
    const attestation = decodeSasAttestation(rawAt(initial, binding.attestation).data)
    return attestation.signer === verifier.address && attestation.credential === original.credential && attestation.schema === original.schema
  }), 'Fixture proofs must be signed by the verifier being revoked')
  tokenAddresses.forEach((address) => {
    const raw = rawAt(initial, address)
    assert.equal(raw.owner, TOKEN_2022_PROGRAM_ID, 'Protected balances must belong to Token-2022')
    assert(getTokenDecoder().decode(raw.data).amount > 0n, 'Both transfer directions require funded token accounts')
  })

  let floor = initial.slot
  let restoreSigners = false
  const errors: unknown[] = []
  const observeSigners = async (expected: Address[]) => {
    const read = await deps.readAccounts(ctx, [original.credential], floor)
    floor = read.slot
    assert.equal(read.accounts[0]?.owner, SAS_PROGRAM_ID)
    const actual = decodeSasCredential(read.accounts[0]!.data).authorizedSigners
    expectSasSignerSet(actual, expected)
    input.emit({ protectedAccount: original.credential, authorizedSigners: actual, slot: read.slot })
  }
  const changeSigners = async (signers: Address[]) => {
    // sas-lib 1.0.10 embeds Kit 5 types; the app uses Kit 8. Signer runtime shape is shared.
    const instruction = deps.getChangeAuthorizedSignersInstruction({ payer: input.issuer as never,
      authority: verifier as never, credential: original.credential, signers }) as Instruction
    await input.send(input.issuer, [instruction])
  }
  const unchanged = (before: AccountsRead, after: AccountsRead, code?: OnchainError) => {
    protectedAddresses.forEach((address, index) => {
      expectSasAccountUnchanged(before.accounts[index] ?? null, after.accounts[index] ?? null)
      input.emit({ protectedAccount: address, accountUnchanged: true, beforeSlot: before.slot, afterSlot: after.slot,
        ...(code ? { hookCode: code } : {}) })
    })
  }
  const reject = async (instructions: Instruction[], code: OnchainError) => {
    const before = await deps.readAccounts(ctx, protectedAddresses, floor)
    const result = requireSasLedgerFailure(await input.reject(input.issuer, instructions, code))
    floor = Math.max(before.slot, result.slot)
    const after = await deps.readAccounts(ctx, protectedAddresses, floor)
    floor = after.slot
    unchanged(before, after, code)
  }
  const rejectBinding = async (candidate: { credential: Address; schema: Address; attestation: Address }, code: OnchainError) => {
    for (const asset of assets) await reject([await deps.getSetBindingInstruction({ programId: ctx.programId,
      subject: x, mint: asset.mint, ...candidate })], code)
  }
  const createProof = async (schemaAddress: Address, data: Uint8Array, authority = verifier) => {
    const nonce = await input.nonce()
    const [attestation] = await deps.deriveAttestationPda({ credential: original.credential, schema: schemaAddress, nonce })
    await input.send(input.issuer, [deps.getCreateAttestationInstruction({ payer: input.issuer as never,
      authority: authority as never, credential: original.credential, schema: schemaAddress, attestation,
      nonce, data, expiry: proof.expiry }) as Instruction])
    const read = await deps.readAccounts(ctx, [attestation], floor)
    floor = read.slot
    assert.equal(read.accounts[0]?.owner, SAS_PROGRAM_ID, 'Auxiliary proof must be created by real SAS')
    const actual = decodeSasAttestation(read.accounts[0]!.data)
    assert(actual.schema === schemaAddress && actual.credential === original.credential && actual.signer === authority.address
      && actual.nonce === nonce && actual.expiry === proof.expiry && bytesEqual(actual.data, data), 'SAS proof readback mismatch')
    input.emit({ proof: attestation, signer: actual.signer, slot: read.slot })
    return attestation
  }

  try {
    // Base-line accepted transfers are balanced immediately; no successful binding replacement is needed.
    for (const asset of assets) {
      await input.transfer(asset, x.address, true)
      await input.transfer(asset, treasury.address, true, undefined, x)
    }
    for (const data of malformedSasEligibilityPayloads(new Uint8Array(proof.data))) {
      const attestation = await createProof(original.schema, data)
      await rejectBinding({ ...original, attestation }, 'InvalidSasOwnerOrData')
    }
    input.complete(SAS_ADVERSARIAL_STAGES[0])

    // Temporarily authorize X, issue a real proof, then restore the original signer set before presenting it.
    const revoked = credential.authorizedSigners.map((signer) => signer === verifier.address ? x.address : signer)
    restoreSigners = true // Arm restoration before sending, including ambiguous confirmation failures.
    await changeSigners(revoked)
    await observeSigners(revoked)
    const unauthorizedProof = await createProof(original.schema, new Uint8Array(proof.data), x)
    await changeSigners(credential.authorizedSigners)
    await observeSigners(credential.authorizedSigners)
    await rejectBinding({ ...original, attestation: unauthorizedProof }, 'UnauthorizedAttestationSigner')
    input.complete(SAS_ADVERSARIAL_STAGES[1])

    await changeSigners(revoked)
    await observeSigners(revoked)
    await rejectBinding(original, 'UnauthorizedAttestationSigner')
    for (const asset of assets) {
      for (const [authority, destination] of [[treasury, x.address], [x, treasury.address]] as const) {
        const before = await deps.readAccounts(ctx, protectedAddresses, floor)
        await input.transfer(asset, destination, false, 'UnauthorizedAttestationSigner', authority)
        const after = await deps.readAccounts(ctx, protectedAddresses, before.slot)
        floor = after.slot
        unchanged(before, after, 'UnauthorizedAttestationSigner')
      }
    }
    input.complete(SAS_ADVERSARIAL_STAGES[2])
  } catch (error) {
    errors.push(error)
  } finally {
    // Reporting failures cannot prevent restoration; independently verify schema, bindings and balances too.
    if (restoreSigners) {
      try { await changeSigners(credential.authorizedSigners) } catch (error) { errors.push(error) }
      try { await observeSigners(credential.authorizedSigners) } catch (error) { errors.push(error) }
    }
    try {
      const restored = await deps.readAccounts(ctx, protectedAddresses, floor)
      unchanged(initial, restored)
    } catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, 'SAS adversarial acceptance or restoration failed')
  input.complete(SAS_ADVERSARIAL_STAGES[3])
}
