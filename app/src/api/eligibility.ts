// Diagnóstico de elegibilidade (inspect). Reproduz, na mesma ordem e com os mesmos códigos, as checagens de
// programs/aveo-hook/src/{eligibility,sas,token_accounts}.rs para UMA das partes da transferência.
// O diagnóstico explica; quem decide é o hook, na hora da transferência (spec v3, seção 7).
import type { Capability } from '@aveo/contracts'
import { DeskError } from '@aveo/contracts'
import { getMintDecoder } from '@solana-program/token-2022'
import { getSysvarClockDecoder } from '@solana/sysvars'
import { unwrapOption, type Address } from '@solana/kit'
import type { RawAccount } from './accounts'
import { readAccounts } from './accounts'
import {
  bytesEqual,
  decodeEligibilityBinding,
  decodeEligibilityPayload,
  decodeIssuerPolicy,
  decodeSasAttestation,
  decodeSasCredential,
  decodeSasSchema,
  isAveoEligibilityV2,
  type EligibilityBinding,
  type IssuerPolicy,
  type SasAttestation,
} from './codecs'
import { LAYOUT_VERSION, SAS_PROGRAM_ID, SYSTEM_PROGRAM_ID, SYSVAR_CLOCK_ID, TOKEN_2022_PROGRAM_ID } from './constants'
import type { ApiContext } from './context'
import { reason, type DeskSnapshot, type DiagnosticReason, type ProofInfo } from './diagnostics'
import { findBindingPda, findPolicyPda, findSasAttestationPda, findSasCredentialPda, findSasSchemaPda } from './pdas'
import { findProofsForWallet } from './proofs'

type Check<T> = { ok: true; value: T } | { ok: false; reason: DiagnosticReason }
const pass = <T>(value: T): Check<T> => ({ ok: true, value })
const fail = <T>(r: DiagnosticReason): Check<T> => ({ ok: false, reason: r })

export function verifierLabel(ctx: ApiContext, credential: Address): string {
  return ctx.deployment.verifiers.find((v) => v.credential === credential)?.label ?? credential
}

export function assetLabel(ctx: ApiContext, mint: Address): string {
  return ctx.deployment.assets.find((a) => a.mint === mint)?.label ?? mint
}

/** load_policy */
export function checkPolicy(ctx: ApiContext, mint: Address, account: RawAccount | null): Check<IssuerPolicy> {
  const missing = () => fail<IssuerPolicy>(reason('PolicyMissingOrInactive', 'policy missing', { params: { asset: assetLabel(ctx, mint) } }))
  if (!account || account.data.length === 0 || account.owner !== ctx.programId) return missing()
  let policy: IssuerPolicy
  try {
    policy = decodeIssuerPolicy(account.data)
  } catch {
    return missing()
  }
  if (policy.mint !== mint) return fail(reason('MintMismatch', 'policy belongs to another mint'))
  if (!policy.active) {
    return fail(reason('PolicyMissingOrInactive', 'policy inactive', { params: { asset: assetLabel(ctx, mint), inactive: 'true' } }))
  }
  if (policy.sasProgramId !== SAS_PROGRAM_ID) return fail(reason('InvalidSasOwnerOrData', 'policy points to another SAS program'))
  if (policy.version !== LAYOUT_VERSION) return missing()
  return pass(policy)
}

/** validate_demo_mint: Token-2022, hook = este programa, sem PermanentDelegate nem Confidential Transfer. */
export function checkMint(ctx: ApiContext, account: RawAccount | null): Check<null> {
  const mismatch = (detail: string) => fail<null>(reason('MintMismatch', detail))
  if (!account || account.owner !== TOKEN_2022_PROGRAM_ID) return mismatch('mint is not a Token-2022 mint')
  let extensions: { __kind: string; programId?: unknown }[]
  try {
    const mint = getMintDecoder().decode(account.data)
    extensions = (unwrapOption(mint.extensions) ?? []) as typeof extensions
  } catch {
    return mismatch('mint could not be decoded')
  }
  const forbidden = ['PermanentDelegate', 'ConfidentialTransferMint', 'ConfidentialTransferFee']
  if (extensions.some((ext) => forbidden.includes(ext.__kind))) return mismatch('mint has a forbidden extension')
  const hook = extensions.find((ext) => ext.__kind === 'TransferHook')
  // O decoder entrega o programId como endereço simples; aceitamos também a forma Option por segurança.
  const raw = hook?.programId
  const programId =
    typeof raw === 'string' ? raw : raw && typeof raw === 'object' && '__option' in raw ? unwrapOption(raw as Parameters<typeof unwrapOption>[0]) : null
  if (programId !== ctx.programId) return mismatch('mint transfer hook is not aveo-hook')
  return pass(null)
}

/** load_binding */
export function checkBinding(
  ctx: ApiContext,
  mint: Address,
  wallet: Address,
  account: RawAccount | null,
): Check<EligibilityBinding> {
  const missing = () => fail<EligibilityBinding>(reason('BindingMissing', 'binding missing', { params: { asset: assetLabel(ctx, mint) } }))
  if (!account || account.data.length === 0 || account.owner !== ctx.programId) return missing()
  let binding: EligibilityBinding
  try {
    binding = decodeEligibilityBinding(account.data)
  } catch {
    return missing()
  }
  if (binding.version !== LAYOUT_VERSION) return missing()
  if (binding.mint !== mint || binding.subjectWallet !== wallet) {
    return fail(reason('BindingSubjectMismatch', 'binding belongs to another wallet or mint'))
  }
  return pass(binding)
}

function sasAccountGone(account: RawAccount | null): boolean {
  return !account || account.data.length === 0 || account.owner === SYSTEM_PROGRAM_ID
}

/** load_and_check_sas: owner, discriminador, PDA e coerência entre credential, schema e attestation. */
export async function checkSas(
  expected: { credential: Address; schema: Address; attestation: Address },
  credentialAccount: RawAccount | null,
  schemaAccount: RawAccount | null,
  attestationAccount: RawAccount | null,
): Promise<Check<SasAttestation>> {
  const invalid = (detail: string) => fail<SasAttestation>(reason('InvalidSasOwnerOrData', detail))
  const closed = () => fail<SasAttestation>(reason('AttestationMissingOrClosed', 'attestation closed or missing'))

  for (const account of [credentialAccount, schemaAccount, attestationAccount]) {
    if (sasAccountGone(account)) return closed()
    if (account!.owner !== SAS_PROGRAM_ID) return invalid('account not owned by SAS')
  }

  let credential, schema, attestation
  try {
    credential = decodeSasCredential(credentialAccount!.data)
    schema = decodeSasSchema(schemaAccount!.data)
    attestation = decodeSasAttestation(attestationAccount!.data)
  } catch {
    return invalid('SAS account could not be decoded')
  }

  if ((await findSasCredentialPda(credential.authority, credential.name)) !== expected.credential) return invalid('credential PDA mismatch')
  if ((await findSasSchemaPda(schema.credential, schema.name, schema.version)) !== expected.schema) return invalid('schema PDA mismatch')
  if ((await findSasAttestationPda(attestation.credential, attestation.schema, attestation.nonce)) !== expected.attestation) {
    return invalid('attestation PDA mismatch')
  }

  const mismatch = () => fail<SasAttestation>(reason('SchemaMismatchOrPaused', 'schema mismatch'))
  if (schema.credential !== expected.credential) return mismatch()
  if (attestation.credential !== expected.credential) return invalid('attestation credential mismatch')
  if (attestation.schema !== expected.schema) return mismatch()
  if (schema.credential !== attestation.credential) return mismatch()
  if (schema.isPaused || !isAveoEligibilityV2(schema)) {
    return fail(reason('SchemaMismatchOrPaused', 'schema paused or not aveo-eligibility-v2', { params: { paused: String(schema.isPaused) } }))
  }
  if (!credential.authorizedSigners.includes(attestation.signer)) {
    return fail(reason('UnauthorizedAttestationSigner', 'signer no longer authorized'))
  }
  return pass(attestation)
}

/**
 * Checagens do payload depois do SAS (require_live_eligibility). O hook para no primeiro erro;
 * o Desk devolve o primeiro como motivo principal e os seguintes como diagnóstico adicional.
 */
export function checkPayload(
  policy: IssuerPolicy,
  wallet: Address,
  attestation: SasAttestation,
  clockUnix: number,
): { reasons: DiagnosticReason[]; proof?: Omit<ProofInfo, 'attestation' | 'credential' | 'schema'> } {
  const reasons: DiagnosticReason[] = []
  if (!(attestation.expiry > BigInt(clockUnix))) {
    reasons.push(reason('AttestationExpired', 'proof expired', { params: { expiry: String(attestation.expiry) } }))
  }
  let payload
  try {
    payload = decodeEligibilityPayload(attestation.data)
  } catch {
    return { reasons: [...reasons, reason('InvalidSasOwnerOrData', 'payload is not aveo-eligibility-v2')] }
  }
  if (payload.subjectWallet !== wallet) reasons.push(reason('SubjectMismatch', 'proof belongs to another wallet'))
  if (!bytesEqual(payload.proofDomain, policy.proofDomain)) reasons.push(reason('ProofDomainMismatch', 'proof issued for another domain'))
  if (policy.requireKyc && !payload.kycPass) reasons.push(reason('RequiredFactMissing', 'kyc missing', { params: { fact: 'kyc' } }))
  if (policy.requireAccredited && !payload.accreditedPass) {
    reasons.push(reason('RequiredFactMissing', 'accreditation missing', { params: { fact: 'accredited' } }))
  }
  return {
    reasons,
    proof: {
      signer: attestation.signer,
      expiry: attestation.expiry,
      kycPass: payload.kycPass,
      accreditedPass: payload.accreditedPass,
    },
  }
}

function clockFrom(account: RawAccount | null): number | undefined {
  if (!account) return undefined
  try {
    return Number(getSysvarClockDecoder().decode(account.data).unixTimestamp)
  } catch {
    return undefined
  }
}

function capabilitiesFor(reasons: DiagnosticReason[]): Capability[] {
  if (reasons.length === 0) return ['transfer']
  const renewable = ['AttestationExpired', 'AttestationMissingOrClosed', 'BindingMissing', 'ProviderPairNotAllowed', 'RequiredFactMissing']
  return reasons.some((r) => renewable.includes(r.code)) ? ['renew-binding'] : []
}

/** Explica um BindingMissing com a prova que a carteira tem disponível (sem mudar o erro que o hook devolve). */
async function bindingHints(ctx: ApiContext, policy: IssuerPolicy, mint: Address, wallet: Address, clockUnix: number) {
  const hints: DiagnosticReason[] = []
  const candidates = await findProofsForWallet(ctx, wallet)
  const live = candidates.filter((c) => c.payload && c.attestation.expiry > BigInt(clockUnix))
  if (live.length === 0) {
    hints.push(reason('AttestationMissingOrClosed', 'no live proof found for this wallet', { hint: true }))
    return hints
  }
  const accepted = live.find((c) => policy.pairs.some((p) => p.credential === c.attestation.credential && p.schema === c.attestation.schema))
  if (!accepted) {
    const first = live[0]!
    hints.push(
      reason('ProviderPairNotAllowed', 'available proof comes from a verifier this asset does not accept', {
        hint: true,
        params: { asset: assetLabel(ctx, mint), verifier: verifierLabel(ctx, first.attestation.credential) },
      }),
    )
    return hints
  }
  const { reasons } = checkPayload(policy, wallet, accepted.attestation, clockUnix)
  if (reasons.length > 0) return reasons.map((r) => ({ ...r, hint: true }))
  hints.push(
    reason('BindingMissing', 'a valid proof is available; the wallet only needs to sign the binding', {
      hint: true,
      params: { asset: assetLabel(ctx, mint), available: accepted.address, verifier: verifierLabel(ctx, accepted.attestation.credential) },
    }),
  )
  return hints
}

/**
 * Lê a prova de um vínculo só para exibi-la. Se a leitura ou a checagem do SAS falhar,
 * a prova não aparece, e o veredito continua o que o hook decidiria.
 */
async function boundProofForDisplay(
  ctx: ApiContext,
  binding: EligibilityBinding,
  wallet: Address,
  policy: IssuerPolicy,
  clockUnix: number,
  minContextSlot: number,
): Promise<{ slot: number; extra: Pick<DeskSnapshot, 'proof' | 'expiresAt'> } | undefined> {
  try {
    const { slot, accounts } = await readAccounts(ctx, [binding.credential, binding.schema, binding.attestation], minContextSlot)
    const [credentialAccount, schemaAccount, attestationAccount] = accounts
    const sas = await checkSas(binding, credentialAccount ?? null, schemaAccount ?? null, attestationAccount ?? null)
    if (!sas.ok) return undefined
    const { proof } = checkPayload(policy, wallet, sas.value, clockUnix)
    if (!proof) return undefined
    return {
      slot,
      extra: {
        proof: { ...proof, attestation: binding.attestation, credential: binding.credential, schema: binding.schema },
        expiresAt: new Date(Number(sas.value.expiry) * 1000).toISOString(),
      },
    }
  } catch {
    return undefined
  }
}

/** Diagnóstico completo de uma carteira num ativo. Nunca devolve "eligible" sem ler tudo com sucesso. */
export async function inspectEligibility(ctx: ApiContext, mint: Address, wallet: Address): Promise<DeskSnapshot> {
  const policyAddress = await findPolicyPda(ctx.programId, mint)
  const bindingAddress = await findBindingPda(ctx.programId, mint, wallet)
  const observedAt = new Date().toISOString()
  const base = {
    backend: 'aveo-sas-hook' as const,
    mint,
    wallet,
    sourceAccounts: { policy: policyAddress, binding: bindingAddress } as DeskSnapshot['sourceAccounts'],
  }
  const read = (slot: number) => ({ cluster: ctx.cluster, rpcUrl: ctx.rpcUrl, slot, commitment: ctx.commitment as 'processed' | 'confirmed' | 'finalized', observedAt })

  try {
    const first = await readAccounts(ctx, [policyAddress, mint, bindingAddress, SYSVAR_CLOCK_ID])
    const [policyAccount, mintAccount, bindingAccount, clockAccount] = first.accounts
    const clockUnix = clockFrom(clockAccount ?? null)
    if (clockUnix === undefined) throw new DeskError('ReadUnverifiable', 'clock sysvar unreadable')

    const done = (reasons: DiagnosticReason[], extra: Partial<DeskSnapshot> = {}, slot = first.slot): DeskSnapshot => ({
      ...base,
      ...extra,
      read: read(slot),
      clockUnix,
      verdict: reasons.filter((r) => !r.hint).length === 0 ? 'eligible' : 'ineligible',
      reasons,
      actions: capabilitiesFor(reasons.filter((r) => !r.hint)),
    })

    const policy = checkPolicy(ctx, mint, policyAccount ?? null)
    if (!policy.ok) return done([policy.reason])
    const policyVersion = policy.value.policyVersion

    const mintCheck = checkMint(ctx, mintAccount ?? null)
    if (!mintCheck.ok) return done([mintCheck.reason], { policyVersion })

    const binding = checkBinding(ctx, mint, wallet, bindingAccount ?? null)
    if (!binding.ok) {
      const hints = binding.reason.code === 'BindingMissing' ? await bindingHints(ctx, policy.value, mint, wallet, clockUnix) : []
      return done([binding.reason, ...hints], { policyVersion })
    }

    const b = binding.value
    const sourceAccounts = { ...base.sourceAccounts, credential: b.credential, schema: b.schema, attestation: b.attestation }
    if (!policy.value.pairs.some((p) => p.credential === b.credential && p.schema === b.schema)) {
      // O hook para aqui. A prova vinculada é lida só para mostrar qual é, sem somar motivos.
      const shown = await boundProofForDisplay(ctx, b, wallet, policy.value, clockUnix, first.slot)
      return done(
        [reason('ProviderPairNotAllowed', 'verifier not accepted', { params: { asset: assetLabel(ctx, mint), verifier: verifierLabel(ctx, b.credential) } })],
        { policyVersion, sourceAccounts, ...shown?.extra },
        shown?.slot ?? first.slot,
      )
    }

    const second = await readAccounts(ctx, [b.credential, b.schema, b.attestation], first.slot)
    const [credentialAccount, schemaAccount, attestationAccount] = second.accounts
    const sas = await checkSas(b, credentialAccount ?? null, schemaAccount ?? null, attestationAccount ?? null)
    if (!sas.ok) return done([sas.reason], { policyVersion, sourceAccounts }, second.slot)

    const { reasons, proof } = checkPayload(policy.value, wallet, sas.value, clockUnix)
    const proofInfo: ProofInfo | undefined = proof
      ? { ...proof, attestation: b.attestation, credential: b.credential, schema: b.schema }
      : undefined
    return done(reasons, {
      policyVersion,
      sourceAccounts,
      proof: proofInfo,
      expiresAt: new Date(Number(sas.value.expiry) * 1000).toISOString(),
    }, second.slot)
  } catch (error) {
    // Leitura falhou: o veredito é "não sei", nunca "elegível" nem "revogado".
    const message = error instanceof Error ? error.message : String(error)
    return {
      ...base,
      read: read(0),
      verdict: 'unknown',
      reasons: [reason('ReadUnverifiable', message)],
      actions: [],
    }
  }
}
