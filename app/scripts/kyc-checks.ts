import type { Address } from '@solana/kit'
import { AVEO_HOOK_PROGRAM_ID } from '../src/api/constants'
import type { ApiContext } from '../src/api/context'
import type { DeskSnapshot } from '../src/api/diagnostics'

export const FALSE_KYC_STAGES = [
  'false-kyc-proof-bound', 'false-kyc-transfers-rejected', 'false-kyc-original-bindings-restored',
] as const

function requireCheck(condition: unknown): asserts condition {
  if (!condition) throw new Error('False KYC observations could not be verified')
}

/** Require KYC to be the sole blocking fact, not a stale read or another proof failure. */
export function requireFalseKycSnapshots(input: {
  ctx: ApiContext; snapshots: readonly DeskSnapshot[]; owner: Address; proof: Address;
  assets: readonly { mint: Address }[]; floor: number
}): void {
  const { ctx, snapshots, owner, proof, assets, floor } = input
  try {
    const endpoint = new URL(ctx.rpcUrl)
    requireCheck(ctx.cluster === 'localnet' && ctx.programId === AVEO_HOOK_PROGRAM_ID
      && (ctx.commitment === 'confirmed' || ctx.commitment === 'finalized')
      && ['http:', 'https:'].includes(endpoint.protocol) && ['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname)
      && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash && endpoint.pathname === '/')
    requireCheck(Number.isSafeInteger(floor) && floor > 0 && assets.length === 2 && snapshots.length === 2
      && new Set(assets.map((asset) => asset.mint)).size === 2
      && new Set(snapshots.map((snapshot) => snapshot.mint)).size === 2)
    for (const snapshot of snapshots) {
      const primary = snapshot.reasons.filter((reason) => !reason.hint)
      requireCheck(assets.some((asset) => asset.mint === snapshot.mint) && snapshot.wallet === owner
        && snapshot.backend === 'aveo-sas-hook' && snapshot.verdict === 'ineligible'
        && snapshot.read.cluster === ctx.cluster && snapshot.read.rpcUrl === ctx.rpcUrl
        && snapshot.read.commitment === ctx.commitment && Number.isSafeInteger(snapshot.read.slot) && snapshot.read.slot >= floor
        && snapshot.sourceAccounts.attestation === proof && snapshot.proof?.attestation === proof
        && snapshot.proof.kycPass === false && snapshot.proof.accreditedPass === true
        && snapshot.clockUnix !== undefined && Number.isSafeInteger(snapshot.clockUnix) && snapshot.clockUnix >= 0
        && snapshot.proof.expiry > BigInt(snapshot.clockUnix)
        && primary.length === 1 && primary[0]!.code === 'RequiredFactMissing' && primary[0]!.params?.fact === 'kyc')
    }
  } catch { throw new Error('False KYC observations could not be verified') }
}
