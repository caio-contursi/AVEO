// Leituras de apoio para as telas: estado da rede, políticas, provas e saldos dos ativos da demo.
import { getMintDecoder, getTokenDecoder } from '@solana-program/token-2022'
import { unwrapOption, type Address } from '@solana/kit'
import type { DeploymentAsset } from '../config/deployment'
import { readAccounts, rpcCall } from './accounts'
import { decodeEligibilityBinding, type IssuerPolicy } from './codecs'
import { SAS_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from './constants'
import type { ApiContext } from './context'
import type { DiagnosticReason } from './diagnostics'
import { checkPolicy } from './eligibility'
import { findBindingPda, findExtraAccountMetasPda, findPolicyPda } from './pdas'
import { findProofsForWallet, type ProofCandidate } from './proofs'
import { tokenAccountsFor } from './transactions'

export interface NetworkStatus {
  slot: number
  version?: string
  programs: { id: Address; label: string; deployed: boolean; executable: boolean }[]
}

export async function readNetworkStatus(ctx: ApiContext): Promise<NetworkStatus> {
  const version = await rpcCall(() => ctx.rpc.getVersion().send())
  const programs = [
    { id: ctx.programId, label: 'aveo-hook' },
    { id: SAS_PROGRAM_ID, label: 'SAS' },
    { id: TOKEN_2022_PROGRAM_ID, label: 'Token-2022' },
  ]
  const { slot, accounts } = await readAccounts(
    ctx,
    programs.map((p) => p.id),
  )
  return {
    slot,
    version: version['solana-core'],
    programs: programs.map((p, i) => ({ ...p, deployed: accounts[i] !== null, executable: accounts[i]?.executable ?? false })),
  }
}

export interface AssetState {
  asset: DeploymentAsset
  policyAddress: Address
  policy?: IssuerPolicy
  policyFailure?: DiagnosticReason
  extraMetasExists: boolean
  mintExists: boolean
  supply?: bigint
  mintAuthority?: Address | null
}

export async function readAssets(ctx: ApiContext): Promise<{ slot: number; assets: AssetState[] }> {
  const rows = await Promise.all(
    ctx.deployment.assets.map(async (asset) => ({
      asset,
      policyAddress: await findPolicyPda(ctx.programId, asset.mint),
      extraMetasAddress: await findExtraAccountMetasPda(ctx.programId, asset.mint),
    })),
  )
  const { slot, accounts } = await readAccounts(
    ctx,
    rows.flatMap((r) => [r.policyAddress, r.extraMetasAddress, r.asset.mint]),
  )
  return {
    slot,
    assets: rows.map((row, i) => {
      const [policyAccount, extraMetasAccount, mintAccount] = [accounts[i * 3], accounts[i * 3 + 1], accounts[i * 3 + 2]]
      const check = checkPolicy(ctx, row.asset.mint, policyAccount ?? null)
      let supply: bigint | undefined
      let mintAuthority: Address | null | undefined
      if (mintAccount) {
        try {
          const mint = getMintDecoder().decode(mintAccount.data)
          supply = mint.supply
          mintAuthority = unwrapOption(mint.mintAuthority)
        } catch {
          supply = undefined
        }
      }
      return {
        asset: row.asset,
        policyAddress: row.policyAddress,
        policy: check.ok ? check.value : undefined,
        policyFailure: check.ok ? undefined : check.reason,
        extraMetasExists: extraMetasAccount !== null && extraMetasAccount !== undefined && extraMetasAccount.owner === ctx.programId,
        mintExists: mintAccount !== null && mintAccount !== undefined && mintAccount.owner === TOKEN_2022_PROGRAM_ID,
        supply,
        mintAuthority,
      }
    }),
  }
}

export interface HoldingRow {
  mint: Address
  wallet: Address
  amount: bigint
}

export async function readHoldings(ctx: ApiContext): Promise<{ slot: number; holdings: HoldingRow[] }> {
  const pairs = ctx.deployment.assets.flatMap((asset) => ctx.deployment.wallets.map((wallet) => ({ asset, wallet })))
  const accounts = (
    await Promise.all(ctx.deployment.assets.map((asset) => tokenAccountsFor(asset.mint, ctx.deployment.wallets.map((w) => w.address))))
  ).flat()
  const { slot, accounts: raw } = await readAccounts(ctx, accounts)
  const decoder = getTokenDecoder()
  return {
    slot,
    holdings: pairs.map(({ asset, wallet }, i) => {
      const account = raw[i]
      let amount = 0n
      if (account) {
        try {
          amount = decoder.decode(account.data).amount
        } catch {
          amount = 0n
        }
      }
      return { mint: asset.mint, wallet: wallet.address, amount }
    }),
  }
}

export interface ProofRow extends ProofCandidate {
  wallet: Address
  /** Ativos cujo binding desta carteira aponta para esta prova. */
  boundTo: Address[]
}

export async function readProofs(ctx: ApiContext): Promise<ProofRow[]> {
  const wallets = ctx.deployment.wallets
  const bindingAddresses = await Promise.all(
    ctx.deployment.assets.flatMap((asset) => wallets.map((wallet) => findBindingPda(ctx.programId, asset.mint, wallet.address))),
  )
  const { accounts } = await readAccounts(ctx, bindingAddresses)
  const bound = new Map<string, Address[]>()
  accounts.forEach((account) => {
    if (!account || account.owner !== ctx.programId) return
    try {
      const binding = decodeEligibilityBinding(account.data)
      const key = `${binding.subjectWallet}:${binding.attestation}`
      bound.set(key, [...(bound.get(key) ?? []), binding.mint])
    } catch {
      // binding ilegível: tratado como ausente
    }
  })
  const perWallet = await Promise.all(wallets.map((wallet) => findProofsForWallet(ctx, wallet.address)))
  return perWallet.flatMap((proofs, i) =>
    proofs.map((proof) => ({
      ...proof,
      wallet: wallets[i]!.address,
      boundTo: bound.get(`${wallets[i]!.address}:${proof.address}`) ?? [],
    })),
  )
}
