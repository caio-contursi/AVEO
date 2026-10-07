// Ações de cenário da demo, executadas FORA do Desk. SOMENTE DESENVOLVIMENTO / LOCALNET.
// Emissão, fechamento e transferência sem a interface. O hook é quem aceita ou recusa.
//
//   pnpm --filter @aveo/app scenario status
//   pnpm --filter @aveo/app scenario issue <carteira> [--verifier A|B] [--ttl segundos] [--kyc true|false] [--accredited true|false]
//   pnpm --filter @aveo/app scenario close <carteira>
//   pnpm --filter @aveo/app scenario transfer <ativo> <de> <para> <quantidade>
//
// <carteira> é o id do manifest (treasury, X, Y, Z); <ativo> é alfa ou beta.
import type { Instruction } from '@solana/kit'
import { deriveAttestationPda, getCloseAttestationInstruction, getCreateAttestationInstruction } from 'sas-lib'
import { encodeEligibilityPayload } from '../src/api/codecs'
import { createApiContext } from '../src/api/context'
import { inspectEligibility } from '../src/api/eligibility'
import { findProofsForWallet } from '../src/api/proofs'
import { buildInstructions, tokenBalances } from '../src/api/transactions'
import { hexToBytes } from '../src/config/deployment'
import { RPC_URL, describeFailure, loadDeployment, loadDevWallets, newDevWallet, send } from './lib'

const deployment = loadDeployment()
const ctx = createApiContext({
  cluster: 'localnet',
  rpcUrl: RPC_URL,
  commitment: 'confirmed',
  programId: deployment.programs.aveoHook,
  deployment,
})

function option(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback
}

function walletById(id: string) {
  const wallet = deployment.wallets.find((w) => w.id === id)
  if (!wallet) throw new Error(`carteira desconhecida: ${id} (use ${deployment.wallets.map((w) => w.id).join(', ')})`)
  return wallet
}

function assetById(id: string) {
  const asset = deployment.assets.find((a) => a.id === id)
  if (!asset) throw new Error(`ativo desconhecido: ${id} (use ${deployment.assets.map((a) => a.id).join(', ')})`)
  return asset
}

async function status() {
  for (const asset of deployment.assets) {
    const owners = deployment.wallets.map((w) => w.address)
    const { balances } = await tokenBalances(ctx, asset.mint, owners)
    for (const [i, wallet] of deployment.wallets.entries()) {
      const snapshot = await inspectEligibility(ctx, asset.mint, wallet.address)
      const reasons = snapshot.reasons.map((r) => `${r.hint ? '(dica) ' : ''}${r.code}`).join(', ')
      console.log(`${asset.symbol.padEnd(5)} ${wallet.label.padEnd(11)} ${String(balances[i]).padStart(5)}  ${snapshot.verdict.padEnd(10)} ${reasons}`)
    }
  }
}

async function issue(walletId: string) {
  const wallet = walletById(walletId)
  const verifierId = option('--verifier', 'A')
  const verifier = deployment.verifiers.find((v) => v.id === verifierId)
  if (!verifier) throw new Error(`verificador desconhecido: ${verifierId}`)
  const keys = await loadDevWallets()
  const authority = keys.get(`verifier-${verifierId.toLowerCase()}`)?.signer
  if (!authority) throw new Error('chave do verificador não encontrada em .dev/wallets.json')
  const ttl = Number(option('--ttl', String(24 * 3600)))
  const nonce = (await newDevWallet('nonce', 'nonce', 'investor')).signer.address
  const [attestation] = await deriveAttestationPda({ credential: verifier.credential, schema: verifier.schema, nonce })
  await send(authority, [
    getCreateAttestationInstruction({
      payer: authority as never,
      authority: authority as never,
      credential: verifier.credential,
      schema: verifier.schema,
      attestation,
      nonce,
      data: encodeEligibilityPayload({
        subjectWallet: wallet.address,
        proofDomain: hexToBytes(deployment.proofDomain),
        kycPass: option('--kyc', 'true') === 'true',
        accreditedPass: option('--accredited', 'true') === 'true',
      }),
      expiry: Math.floor(Date.now() / 1000) + ttl,
    }) as unknown as Instruction,
  ])
  console.log(`Prova nova do ${verifier.label} para ${wallet.label}: ${attestation} (vence em ${ttl}s).`)
  console.log('A carteira ainda precisa assinar o novo vínculo (set_binding) no Desk.')
}

async function close(walletId: string) {
  const wallet = walletById(walletId)
  const proofs = await findProofsForWallet(ctx, wallet.address)
  if (proofs.length === 0) throw new Error(`nenhuma prova encontrada para ${wallet.label}`)
  const keys = await loadDevWallets()
  for (const proof of proofs) {
    const verifier = deployment.verifiers.find((v) => v.credential === proof.attestation.credential)!
    const authority = keys.get(`verifier-${verifier.id.toLowerCase()}`)!.signer
    await send(authority, [
      getCloseAttestationInstruction({
        payer: authority as never,
        authority: authority as never,
        credential: proof.attestation.credential,
        attestation: proof.address,
      }) as unknown as Instruction,
    ])
    console.log(`Prova ${proof.address} (${verifier.label}) fechada pelo signer autorizado.`)
  }
}

async function transfer(assetId: string, fromId: string, toId: string, amount: string) {
  const asset = assetById(assetId)
  const from = walletById(fromId)
  const to = walletById(toId)
  const keys = await loadDevWallets()
  const signer = keys.get(fromId)?.signer
  if (!signer) throw new Error(`chave de ${fromId} não encontrada`)
  const request = {
    kind: 'transfer' as const,
    mint: asset.mint,
    sourceOwner: from.address,
    destinationOwner: to.address,
    amount: BigInt(amount),
    decimals: asset.decimals,
  }
  try {
    const signature = await send(signer, await buildInstructions(ctx, request, signer), 1_000_000)
    console.log(`ACEITA pelo hook: ${amount} ${asset.symbol} de ${from.label} para ${to.label} (${signature})`)
  } catch (error) {
    const code = error instanceof Error && 'reason' in error ? (error as { reason: { code: string } }).reason.code : describeFailure(error, ctx.programId)
    console.log(`RECUSADA: ${amount} ${asset.symbol} de ${from.label} para ${to.label} → ${code}`)
    process.exitCode = 2
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2).filter((arg, i, all) => !arg.startsWith('--') && !all[i - 1]?.startsWith('--'))
  switch (command) {
    case 'status':
      return status()
    case 'issue':
      return issue(args[0] ?? 'X')
    case 'close':
      return close(args[0] ?? 'X')
    case 'transfer':
      if (args.length < 4) throw new Error('uso: transfer <ativo> <de> <para> <quantidade>')
      return transfer(args[0]!, args[1]!, args[2]!, args[3]!)
    default:
      console.log('Comandos: status | issue <carteira> | close <carteira> | transfer <ativo> <de> <para> <quantidade>')
  }
}

// Sem process.exit: no Windows, encerrar com conexões abertas derruba o Node 24 (libuv).
main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
