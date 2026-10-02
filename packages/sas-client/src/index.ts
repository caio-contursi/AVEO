/**
 * Aveo helpers for the official Solana Attestation Service.
 * Credential and schema creation still go through `sas-lib` (see `app/scripts/fixtures.ts`).
 * This module pins the one rule the hook and the Desk must share: PDA name seeds.
 */

/**
 * SAS PDA seeds are at most 32 bytes. sas-lib 1.0.10 documents this prefix
 * (`dist/src/pdas.js`) but passes the string through, so a longer name throws
 * there. The hook truncates, and callers of sas-lib must pass this prefix.
 */
export const SAS_NAME_SEED_LEN = 32

export function sasNameSeed(name: ArrayLike<number>): Uint8Array {
  const end = name.length > SAS_NAME_SEED_LEN ? SAS_NAME_SEED_LEN : name.length
  const out = new Uint8Array(end)
  for (let i = 0; i < end; i += 1) out[i] = name[i] ?? 0
  return out
}
