// Prepara o validador local com o cenário do spec v3 (seção 5). SOMENTE DESENVOLVIMENTO / LOCALNET.
// Provas sintéticas; nenhum dado real. Gera app/.dev/deployment.json (endereços) e app/.dev/wallets.json
// (chaves das carteiras sintéticas, nunca versionado).
//
//   pnpm --filter @aveo/app fixtures [--x-ttl 1200]
//
// Cria, usando os programas reais (aveo-hook, SAS e Token-2022):
//   - verificadores A e B (credential + schema aveo-eligibility-v2);
//   - provas: tesouraria (A, KYC + credenciado), X (A, KYC + credenciado, validade curta),
//     Y (B, KYC, sem credenciamento) e Z (A, KYC, sem credenciamento);
//   - mints Alfa (aceita A ou B, exige KYC) e Beta (aceita só A, exige KYC + credenciamento),
//     com Transfer Hook = aveo-hook, políticas e ExtraAccountMetaList;
//   - contas de token, emissão inicial na tesouraria e bindings;
//   - transferências iniciais da tesouraria, que já passam pelo hook.
import {
  AuthorityType,
  TOKEN_2022_PROGRAM_ADDRESS,
  extension,
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMint2Instruction,
  getInitializeTransferHookInstruction,
  getMintSize,
  getMintToCheckedInstruction,
  getSetAuthorityInstruction,
} from '@solana-program/token-2022'
import { getCreateAccountInstruction } from '@solana-program/system'
import { airdropFactory, lamports, type Address, type Instruction, type KeyPairSigner } from '@solana/kit'
import { createHash } from 'node:crypto'
import {
  deriveAttestationPda,
  deriveCredentialPda,
  deriveSchemaPda,
  getCreateAttestationInstruction,
  getCreateCredentialInstruction,
  getCreateSchemaInstruction,
} from 'sas-lib'
import { encodeEligibilityPayload } from '../src/api/codecs'
import { AVEO_ELIGIBILITY_V2_LAYOUT, AVEO_HOOK_PROGRAM_ID, SAS_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '../src/api/constants'
import { createApiContext } from '../src/api/context'
import { getInitExtraMetasInstruction, getInitPolicyInstruction, getSetBindingInstruction } from '../src/api/instructions'
import { buildInstructions, tokenAccountsFor } from '../src/api/transactions'
import { bytesToHex, type Deployment } from '../src/config/deployment'
import {
  DEPLOYMENT_FILE,
  RPC_URL,
  WALLETS_FILE,
  describeFailure,
  log,
  newDevWallet,
  rpc,
  rpcSubscriptions,
  send,
  writeJson,
  type DevWalletRecord,
} from './lib'

const SCHEMA_NAME = 'aveo-eligibility-v2'
const FIELD_NAMES = ['version', 'subject_wallet', 'proof_domain', 'kyc_pass', 'accredited_pass']
const DAY = 86_400

function argNumber(flag: string, fallback: number): number {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? Number(process.argv[index + 1]) : fallback
}

const asInstruction = (ix: unknown) => ix as Instruction

async function requirePrograms() {
  const { value } = await rpc.getMultipleAccounts([AVEO_HOOK_PROGRAM_ID, SAS_PROGRAM_ID, TOKEN_2022_PROGRAM_ID], { encoding: 'base64' }).send()
  const names = ['aveo-hook', 'SAS', 'Token-2022']
  value.forEach((account, i) => {
    if (!account?.executable) throw new Error(`${names[i]} não está carregado no validador (${RPC_URL}). Rode: node dev/solana/docker.mjs validator`)
  })
}

async function main() {
  const xTtl = argNumber('--x-ttl', 20 * 60)
  await requirePrograms()
  log('Programas encontrados', RPC_URL)

  // Carteiras sintéticas
  const wallets: { record: DevWalletRecord; signer: KeyPairSigner }[] = []
  const make = async (id: string, label: string, role: DevWalletRecord['role']) => {
    const wallet = await newDevWallet(id, label, role)
    wallets.push(wallet)
    return wallet.signer
  }
  const issuer = await make('issuer', 'Emissor (Alfa e Beta)', 'issuer')
  const verifierA = await make('verifier-a', 'Verificador A', 'verifier')
  const verifierB = await make('verifier-b', 'Verificador B', 'verifier')
  const treasury = await make('treasury', 'Tesouraria', 'treasury')
  const walletX = await make('X', 'Carteira X', 'investor')
  const walletY = await make('Y', 'Carteira Y', 'investor')
  const walletZ = await make('Z', 'Carteira Z', 'investor')
  writeJson(WALLETS_FILE, { warning: 'Chaves sintéticas de localnet. Nunca use com fundos reais.', wallets: wallets.map((w) => w.record) })

  const airdrop = airdropFactory({ rpc, rpcSubscriptions })
  for (const w of wallets) {
    await airdrop({ recipientAddress: w.signer.address, lamports: lamports(10_000_000_000n), commitment: 'confirmed' })
  }
  log('Carteiras sintéticas criadas e com SOL de teste', `${wallets.length}`)

  // Verificadores A e B no SAS
  const verifiers = []
  for (const [id, label, authority] of [
    ['A', 'Verificador A', verifierA],
    ['B', 'Verificador B', verifierB],
  ] as const) {
    const name = `aveo-verificador-${id.toLowerCase()}`
    const [credential] = await deriveCredentialPda({ authority: authority.address, name })
    const [schema] = await deriveSchemaPda({ credential, name: SCHEMA_NAME, version: 1 })
    await send(authority, [
      asInstruction(getCreateCredentialInstruction({ payer: authority as never, credential, authority: authority as never, name, signers: [authority.address] })),
      asInstruction(
        getCreateSchemaInstruction({
          payer: authority as never,
          authority: authority as never,
          credential,
          schema,
          name: SCHEMA_NAME,
          description: 'Aveo synthetic eligibility (demo, no real KYC)',
          layout: new Uint8Array(AVEO_ELIGIBILITY_V2_LAYOUT),
          fieldNames: FIELD_NAMES,
        }),
      ),
    ])
    verifiers.push({ id, label, authority: authority.address, credential: credential as Address, schema: schema as Address, signer: authority })
    log(`Verificador ${id}`, `credential ${credential}`)
  }
  const [vA, vB] = verifiers as [(typeof verifiers)[number], (typeof verifiers)[number]]

  // Provas (atestações) sintéticas
  const proofDomain = new Uint8Array(createHash('sha256').update('aveo-demo-localnet').digest())
  const now = Math.floor(Date.now() / 1000)
  const proofs = [
    { subject: treasury, verifier: vA, kyc: true, accredited: true, ttl: 30 * DAY },
    { subject: walletX, verifier: vA, kyc: true, accredited: true, ttl: xTtl },
    { subject: walletY, verifier: vB, kyc: true, accredited: false, ttl: 30 * DAY },
    { subject: walletZ, verifier: vA, kyc: true, accredited: false, ttl: 30 * DAY },
  ]
  const attestationOf = new Map<Address, Address>()
  for (const proof of proofs) {
    const nonce = (await newDevWallet('nonce', 'nonce', 'investor')).signer.address
    const [attestation] = await deriveAttestationPda({ credential: proof.verifier.credential, schema: proof.verifier.schema, nonce })
    await send(proof.verifier.signer, [
      asInstruction(
        getCreateAttestationInstruction({
          payer: proof.verifier.signer as never,
          authority: proof.verifier.signer as never,
          credential: proof.verifier.credential,
          schema: proof.verifier.schema,
          attestation,
          nonce,
          data: encodeEligibilityPayload({
            subjectWallet: proof.subject.address,
            proofDomain,
            kycPass: proof.kyc,
            accreditedPass: proof.accredited,
          }),
          expiry: now + proof.ttl,
        }),
      ),
    ])
    attestationOf.set(proof.subject.address, attestation as Address)
  }
  log('Provas emitidas', `X vence em ${Math.round(xTtl / 60)} min`)

  // Mints Alfa e Beta com Transfer Hook
  const policies = [
    { id: 'alfa', label: 'Ativo Alfa', symbol: 'ALFA', pairs: [vA, vB], requireKyc: true, requireAccredited: false },
    { id: 'beta', label: 'Ativo Beta', symbol: 'BETA', pairs: [vA], requireKyc: true, requireAccredited: true },
  ]
  const assets: Deployment['assets'] = []
  for (const p of policies) {
    const mint = (await newDevWallet(`mint-${p.id}`, p.label, 'investor')).signer
    const hook = extension('TransferHook', { authority: issuer.address, programId: AVEO_HOOK_PROGRAM_ID })
    const space = getMintSize([hook])
    const rent = await rpc.getMinimumBalanceForRentExemption(BigInt(space)).send()
    await send(issuer, [
      getCreateAccountInstruction({ payer: issuer, newAccount: mint, lamports: rent, space, programAddress: TOKEN_2022_PROGRAM_ADDRESS }),
      getInitializeTransferHookInstruction({ mint: mint.address, authority: issuer.address, programId: AVEO_HOOK_PROGRAM_ID }),
      getInitializeMint2Instruction({ mint: mint.address, decimals: 0, mintAuthority: issuer.address, freezeAuthority: null }),
    ])
    const args = {
      proofDomain,
      pairs: p.pairs.map((v) => ({ credential: v.credential, schema: v.schema })),
      requireKyc: p.requireKyc,
      requireAccredited: p.requireAccredited,
      active: true,
    }
    await send(issuer, [
      await getInitPolicyInstruction({ programId: AVEO_HOOK_PROGRAM_ID, authority: issuer, mint: mint.address, args }),
      await getInitExtraMetasInstruction({ programId: AVEO_HOOK_PROGRAM_ID, authority: issuer, mint: mint.address }),
    ])
    assets.push({ id: p.id, label: p.label, symbol: p.symbol, mint: mint.address, decimals: 0 })
    log(`Mint ${p.symbol}`, `${mint.address}`)
  }

  // Contas de token, emissão na tesouraria e remoção da mint authority (spec 6.6)
  const holders = [treasury, walletX, walletY, walletZ]
  for (const asset of assets) {
    const atas = await tokenAccountsFor(asset.mint, holders.map((h) => h.address))
    await send(
      issuer,
      holders.map((holder, i) =>
        getCreateAssociatedTokenIdempotentInstruction({ payer: issuer, ata: atas[i]!, owner: holder.address, mint: asset.mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }),
      ),
    )
    await send(issuer, [
      getMintToCheckedInstruction({ mint: asset.mint, token: atas[0]!, mintAuthority: issuer, amount: 1000n, decimals: 0 }),
      getSetAuthorityInstruction({ owned: asset.mint, owner: issuer, authorityType: AuthorityType.MintTokens, newAuthority: null }),
    ])
  }
  log('Contas de token criadas, 1000 de cada ativo na tesouraria, mint authority removida')

  // Bindings: cada carteira assina o vínculo da própria prova
  const verifierOf = new Map(proofs.map((p) => [p.subject.address, p.verifier]))
  const bind = async (holder: KeyPairSigner, asset: (typeof assets)[number]) => {
    const verifier = verifierOf.get(holder.address)!
    try {
      await send(holder, [
        await getSetBindingInstruction({
          programId: AVEO_HOOK_PROGRAM_ID,
          subject: holder,
          mint: asset.mint,
          credential: verifier.credential,
          schema: verifier.schema,
          attestation: attestationOf.get(holder.address)!,
        }),
      ])
      return 'ok'
    } catch (error) {
      return describeFailure(error, AVEO_HOOK_PROGRAM_ID)
    }
  }
  for (const asset of assets) {
    for (const holder of holders) {
      const result = await bind(holder, asset)
      log(`set_binding ${asset.symbol}`, `${wallets.find((w) => w.signer.address === holder.address)!.record.label}: ${result}`)
    }
  }

  const deployment: Deployment = {
    version: 1,
    cluster: 'localnet',
    generatedAt: new Date().toISOString(),
    programs: { aveoHook: AVEO_HOOK_PROGRAM_ID, sas: SAS_PROGRAM_ID, token2022: TOKEN_2022_PROGRAM_ID },
    proofDomain: bytesToHex(proofDomain),
    issuer: issuer.address,
    verifiers: verifiers.map(({ id, label, authority, credential, schema }) => ({ id, label, authority, credential, schema })),
    assets,
    wallets: [
      { id: 'treasury', label: 'Tesouraria', address: treasury.address, role: 'treasury' },
      { id: 'X', label: 'Carteira X', address: walletX.address, role: 'investor' },
      { id: 'Y', label: 'Carteira Y', address: walletY.address, role: 'investor' },
      { id: 'Z', label: 'Carteira Z', address: walletZ.address, role: 'investor' },
    ],
  }
  writeJson(DEPLOYMENT_FILE, deployment)

  // Transferências iniciais pela tesouraria: passam pelo hook de verdade
  const ctx = createApiContext({ cluster: 'localnet', rpcUrl: RPC_URL, commitment: 'confirmed', programId: AVEO_HOOK_PROGRAM_ID, deployment })
  const transfers = [
    { asset: assets[0]!, to: walletX, amount: 50n },
    { asset: assets[1]!, to: walletX, amount: 20n },
    { asset: assets[0]!, to: walletY, amount: 30n },
    { asset: assets[0]!, to: walletZ, amount: 10n },
  ]
  for (const t of transfers) {
    const request = { kind: 'transfer' as const, mint: t.asset.mint, sourceOwner: treasury.address, destinationOwner: t.to.address, amount: t.amount, decimals: 0 }
    try {
      await send(treasury, await buildInstructions(ctx, request, treasury), 1_000_000)
      log(`Transferência ${t.amount} ${t.asset.symbol}`, `tesouraria → ${t.to.address}: ok (hook aprovou)`)
    } catch (error) {
      log(`Transferência ${t.amount} ${t.asset.symbol}`, `FALHOU: ${describeFailure(error, AVEO_HOOK_PROGRAM_ID)}`)
    }
  }

  console.log(`\nManifest: ${DEPLOYMENT_FILE}\nCarteiras sintéticas: ${WALLETS_FILE}`)
}

// Sem process.exit: no Windows, encerrar com conexões abertas derruba o Node 24 (libuv).
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
