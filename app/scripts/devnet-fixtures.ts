// Synthetic devnet fixtures. Custody, cluster checks and mutation budgets belong to the runtime.
import {
  AuthorityType, TOKEN_2022_PROGRAM_ADDRESS, extension,
  getCreateAssociatedTokenIdempotentInstruction, getInitializeMint2Instruction,
  getInitializeTransferHookInstruction, getMintSize, getMintToCheckedInstruction,
  getSetAuthorityInstruction, getMintDecoder, getTokenDecoder,
} from '@solana-program/token-2022'
import { getCreateAccountInstruction } from '@solana-program/system'
import type { Address, Instruction, Signature } from '@solana/kit'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  deriveAttestationPda, deriveCredentialPda, deriveSchemaPda,
  getCreateAttestationInstruction, getCreateCredentialInstruction, getCreateSchemaInstruction,
} from 'sas-lib'
import { encodeEligibilityPayload } from '../src/api/codecs'
import { readAccounts } from '../src/api/accounts'
import { AVEO_ELIGIBILITY_V2_LAYOUT, AVEO_DEVNET_HOOK_PROGRAM_ID, SAS_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '../src/api/constants'
import type { ApiContext } from '../src/api/context'
import { getInitExtraMetasInstruction, getInitPolicyInstruction, getSetBindingInstruction } from '../src/api/instructions'
import { buildInstructions, tokenAccountsFor } from '../src/api/transactions'
import { bytesToHex, type Deployment } from '../src/config/deployment'
import type { DevnetRuntime, DevnetWalletRecord } from './devnet-runtime'

/** Structural contract: importing the generator never loads a runtime or local key records. */
export type DevnetFixtureRuntime = DevnetRuntime

export interface DevnetFixtureOptions {
  directory: string
  rpcUrl: string
  wsUrl: string
  ttl: number
}

function requireTtl(ttl: number): void {
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || !Number.isSafeInteger(Math.floor(Date.now() / 1000) + ttl)) {
    throw new Error('TTL must be a positive safe integer in seconds')
  }
}

/** Reject all incomplete or ambiguous CLI input before loading the runtime. */
export function parseDevnetFixtureArgs(args: string[]): DevnetFixtureOptions {
  const values = new Map<string, string>()
  let execute = false
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (flag === '--execute-synthetic-devnet') {
      if (execute) throw new Error('Duplicate execution flag')
      execute = true
      continue
    }
    const value = args[++i]
    if (!['--directory', '--rpc', '--ws', '--x-ttl'].includes(flag) || values.has(flag) || !value || value.startsWith('--')) {
      throw new Error('Invalid fixture arguments')
    }
    values.set(flag, value)
  }
  const directory = values.get('--directory')
  const rpcUrl = values.get('--rpc')
  const wsUrl = values.get('--ws')
  if (!execute || !directory || !path.isAbsolute(directory) || !rpcUrl || !wsUrl) {
    throw new Error('Supply --execute-synthetic-devnet, --directory <absolute path>, --rpc <HTTP(S) URL> and --ws <WS(S) URL>')
  }
  for (const [value, protocols] of [[rpcUrl, ['http:', 'https:']], [wsUrl, ['ws:', 'wss:']]] as const) {
    let url: URL
    try { url = new URL(value) } catch { throw new Error('Invalid endpoint URL') }
    if (!(protocols as readonly string[]).includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) {
      throw new Error('Invalid endpoint URL')
    }
  }
  const rawTtl = values.get('--x-ttl')
  if (rawTtl !== undefined && !/^\d+$/.test(rawTtl)) throw new Error('TTL must contain integer seconds')
  const ttl = rawTtl === undefined ? 1200 : Number(rawTtl)
  requireTtl(ttl)
  return { directory, rpcUrl, wsUrl, ttl }
}

const asInstruction = (instruction: unknown): Instruction => instruction as Instruction
const DAY = 86_400

/** Only the supplied, validated runtime may create keys, fund wallets or send transactions. */
export async function buildDevnetFixtures(runtime: DevnetFixtureRuntime, ttl = 1200): Promise<Deployment> {
  requireTtl(ttl)
  const make = async (id: string, label: string, role: DevnetWalletRecord['role']) =>
    (await runtime.newWallet(id, label, role)).signer
  const issuer = await make('issuer', 'Issuer (Alfa and Beta)', 'issuer')
  const verifierA = await make('verifier-a', 'Verifier A', 'verifier')
  const verifierB = await make('verifier-b', 'Verifier B', 'verifier')
  const treasury = await make('treasury', 'Treasury', 'treasury')
  const walletX = await make('X', 'Wallet X', 'investor')
  const walletY = await make('Y', 'Wallet Y', 'investor')
  const walletZ = await make('Z', 'Wallet Z', 'investor')
  await runtime.fund(issuer.address, 1_000_000_000n)
  for (const wallet of [verifierA, verifierB, treasury, walletX, walletY, walletZ]) {
    await runtime.fund(wallet.address, 50_000_000n)
  }

  const verifiers = []
  for (const [id, authority] of [['A', verifierA], ['B', verifierB]] as const) {
    const name = `aveo-verificador-${id.toLowerCase()}`
    const [credential] = await deriveCredentialPda({ authority: authority.address, name })
    const [schema] = await deriveSchemaPda({ credential, name: 'aveo-eligibility-v2', version: 1 })
    await runtime.send(authority, [
      asInstruction(getCreateCredentialInstruction({ payer: authority as never, credential, authority: authority as never, name, signers: [authority.address] })),
      asInstruction(getCreateSchemaInstruction({
        payer: authority as never, authority: authority as never, credential, schema,
        name: 'aveo-eligibility-v2', description: 'Aveo synthetic eligibility (demo, no real KYC)',
        layout: new Uint8Array(AVEO_ELIGIBILITY_V2_LAYOUT),
        fieldNames: ['version', 'subject_wallet', 'proof_domain', 'kyc_pass', 'accredited_pass'],
      })),
    ])
    verifiers.push({ id, label: `Verifier ${id}`, authority: authority.address, credential: credential as Address, schema: schema as Address, signer: authority })
  }
  const [vA, vB] = verifiers as [typeof verifiers[number], typeof verifiers[number]]
  const proofDomain = new Uint8Array(createHash('sha256').update('aveo-demo-devnet').digest())
  const now = Math.floor(Date.now() / 1000)
  const proofs = [
    { subject: treasury, verifier: vA, kyc: true, accredited: true, ttl: 30 * DAY },
    { subject: walletX, verifier: vA, kyc: true, accredited: true, ttl },
    { subject: walletY, verifier: vB, kyc: true, accredited: false, ttl: 30 * DAY },
    { subject: walletZ, verifier: vA, kyc: true, accredited: false, ttl: 30 * DAY },
  ]
  const attestationOf = new Map<Address, Address>()
  for (const [index, proof] of proofs.entries()) {
    const nonce = (await make(`nonce-${index + 1}`, 'Attestation nonce', 'investor')).address
    const [attestation] = await deriveAttestationPda({ credential: proof.verifier.credential, schema: proof.verifier.schema, nonce })
    await runtime.send(proof.verifier.signer, [asInstruction(getCreateAttestationInstruction({
      payer: proof.verifier.signer as never, authority: proof.verifier.signer as never,
      credential: proof.verifier.credential, schema: proof.verifier.schema, attestation, nonce,
      data: encodeEligibilityPayload({ subjectWallet: proof.subject.address, proofDomain, kycPass: proof.kyc, accreditedPass: proof.accredited }),
      expiry: now + proof.ttl,
    }))])
    attestationOf.set(proof.subject.address, attestation as Address)
  }

  const policies = [
    { id: 'alfa', label: 'Asset Alfa', symbol: 'ALFA', pairs: [vA, vB], requireKyc: true, requireAccredited: false },
    { id: 'beta', label: 'Asset Beta', symbol: 'BETA', pairs: [vA], requireKyc: true, requireAccredited: true },
  ]
  const assets: Deployment['assets'] = []
  for (const policy of policies) {
    const mint = await make(`mint-${policy.id}`, policy.label, 'investor')
    const space = getMintSize([extension('TransferHook', { authority: issuer.address, programId: AVEO_DEVNET_HOOK_PROGRAM_ID })])
    const rent = await runtime.rpc.getMinimumBalanceForRentExemption(BigInt(space)).send()
    await runtime.send(issuer, [
      getCreateAccountInstruction({ payer: issuer, newAccount: mint, lamports: rent, space, programAddress: TOKEN_2022_PROGRAM_ADDRESS }),
      getInitializeTransferHookInstruction({ mint: mint.address, authority: issuer.address, programId: AVEO_DEVNET_HOOK_PROGRAM_ID }),
      getInitializeMint2Instruction({ mint: mint.address, decimals: 0, mintAuthority: issuer.address, freezeAuthority: null }),
    ])
    await runtime.send(issuer, [
      await getInitPolicyInstruction({ programId: AVEO_DEVNET_HOOK_PROGRAM_ID, authority: issuer, mint: mint.address, args: {
        proofDomain, pairs: policy.pairs.map(({ credential, schema }) => ({ credential, schema })),
        requireKyc: policy.requireKyc, requireAccredited: policy.requireAccredited, active: true,
      } }),
      await getInitExtraMetasInstruction({ programId: AVEO_DEVNET_HOOK_PROGRAM_ID, authority: issuer, mint: mint.address }),
    ])
    assets.push({ id: policy.id, label: policy.label, symbol: policy.symbol, mint: mint.address, decimals: 0 })
  }
  const deployment: Deployment = {
    version: 1, cluster: 'devnet', generatedAt: new Date().toISOString(),
    programs: { aveoHook: AVEO_DEVNET_HOOK_PROGRAM_ID, sas: SAS_PROGRAM_ID, token2022: TOKEN_2022_PROGRAM_ID },
    proofDomain: bytesToHex(proofDomain), issuer: issuer.address,
    verifiers: verifiers.map(({ id, label, authority, credential, schema }) => ({ id, label, authority, credential, schema })),
    assets,
    wallets: [
      { id: 'treasury', label: 'Treasury', address: treasury.address, role: 'treasury' },
      { id: 'X', label: 'Wallet X', address: walletX.address, role: 'investor' },
      { id: 'Y', label: 'Wallet Y', address: walletY.address, role: 'investor' },
      { id: 'Z', label: 'Wallet Z', address: walletZ.address, role: 'investor' },
    ],
  }
  // Reuse the runtime RPC so even transfer-hook account resolution stays on its endpoint.
  const ctx: ApiContext = { cluster: 'devnet', rpcUrl: runtime.rpcUrl, rpc: runtime.rpc, commitment: 'confirmed', programId: AVEO_DEVNET_HOOK_PROGRAM_ID, deployment }
  const holders = [treasury, walletX, walletY, walletZ]
  for (const asset of assets) {
    const atas = await tokenAccountsFor(asset.mint, holders.map((holder) => holder.address))
    await runtime.send(issuer, holders.map((holder, i) => getCreateAssociatedTokenIdempotentInstruction({
      payer: issuer, ata: atas[i]!, owner: holder.address, mint: asset.mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    })))
    await runtime.send(issuer, [
      getMintToCheckedInstruction({ mint: asset.mint, token: atas[0]!, mintAuthority: issuer, amount: 1000n, decimals: 0 }),
      getSetAuthorityInstruction({ owned: asset.mint, owner: issuer, authorityType: AuthorityType.MintTokens, newAuthority: null }),
    ])
  }
  for (const asset of assets) {
    for (const proof of proofs) {
      await runtime.send(proof.subject, [await getSetBindingInstruction({
        programId: AVEO_DEVNET_HOOK_PROGRAM_ID, subject: proof.subject, mint: asset.mint,
        credential: proof.verifier.credential, schema: proof.verifier.schema, attestation: attestationOf.get(proof.subject.address)!,
      })])
    }
  }
  const transferSignatures: Signature[] = []
  for (const [asset, to, amount] of [
    [assets[0]!, walletX, 50n], [assets[1]!, walletX, 20n],
    [assets[0]!, walletY, 30n], [assets[0]!, walletZ, 10n],
  ] as const) {
    const instructions = await buildInstructions(ctx, {
      kind: 'transfer', mint: asset.mint, sourceOwner: treasury.address, destinationOwner: to.address, amount, decimals: 0,
    }, treasury)
    transferSignatures.push(await runtime.send(treasury, instructions, 1_000_000))
  }
  // Require a snapshot at or after every initial transfer, never an earlier cached balance.
  const { value: statuses } = await runtime.rpc.getSignatureStatuses(transferSignatures, { searchTransactionHistory: true }).send({ abortSignal: AbortSignal.timeout(10_000) })
  if (statuses.length !== transferSignatures.length || statuses.some((status) => !status || status.err !== null
    || !['confirmed', 'finalized'].includes(status.confirmationStatus ?? '') || !Number.isSafeInteger(Number(status.slot)) || Number(status.slot) <= 0)) {
    throw new Error('Initial transfers need successful confirmed ledger statuses before accounting')
  }
  const floor = Math.max(...statuses.map((status) => Number(status!.slot)))
  const atasByAsset = await Promise.all(assets.map((asset) => tokenAccountsFor(asset.mint, holders.map((holder) => holder.address))))
  const addresses = assets.flatMap((asset, i) => [asset.mint, ...atasByAsset[i]!])
  const observed = await readAccounts(ctx, addresses, floor)
  if (!Number.isSafeInteger(observed.slot) || observed.slot < floor || observed.accounts.length !== addresses.length) {
    throw new Error('Invalid or stale final fixture accounting snapshot')
  }
  for (const [i, asset] of assets.entries()) {
    const rawMint = observed.accounts[i * 5]
    if (!rawMint || rawMint.address !== asset.mint || rawMint.owner !== TOKEN_2022_PROGRAM_ID || rawMint.executable) {
      throw new Error('Invalid final fixture mint account')
    }
    const mint = getMintDecoder().decode(rawMint.data)
    const hook = mint.extensions.__option === 'Some' ? mint.extensions.value.find((item) => item.__kind === 'TransferHook') : undefined
    if (mint.supply !== 1000n || mint.mintAuthority.__option !== 'None' || mint.freezeAuthority.__option !== 'None'
      || !mint.isInitialized || mint.decimals !== 0 || hook?.__kind !== 'TransferHook'
      || hook.programId !== AVEO_DEVNET_HOOK_PROGRAM_ID || hook.authority !== issuer.address) {
      throw new Error('Final mint supply, authorities or transfer hook do not match the fixture')
    }
    const expected = i === 0 ? [910n, 50n, 30n, 10n] : [980n, 20n, 0n, 0n]
    for (const [j, holder] of holders.entries()) {
      const raw = observed.accounts[i * 5 + j + 1]
      if (!raw || raw.address !== atasByAsset[i]![j] || raw.owner !== TOKEN_2022_PROGRAM_ID || raw.executable) {
        throw new Error('Invalid final fixture token account')
      }
      const token = getTokenDecoder().decode(raw.data)
      if (token.mint !== asset.mint || token.owner !== holder.address || token.state !== 1 || token.amount !== expected[j]) {
        throw new Error('Final token identity, state or balance does not match the fixture')
      }
    }
  }
  runtime.writePublicDeployment(deployment)
  return deployment
}

export async function runDevnetFixturesCli(
  args: string[],
  createRuntime: (options: Omit<DevnetFixtureOptions, 'ttl'>) => Promise<DevnetFixtureRuntime> = async (options) => {
    const { createDevnetRuntime } = await import('./devnet-runtime')
    return createDevnetRuntime(options)
  },
): Promise<Deployment> {
  const { ttl, ...options } = parseDevnetFixtureArgs(args)
  return buildDevnetFixtures(await createRuntime(options), ttl)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runDevnetFixturesCli(process.argv.slice(2)).then(() => {
    console.log('Synthetic devnet fixtures created; public deployment saved by the runtime.')
  }).catch(() => {
    // Runtime journals retain details. Do not expose secret keys or authenticated endpoint URLs.
    console.error('Devnet fixture generation failed. Check arguments and the private runtime journal; do not rerun an existing directory.')
    process.exitCode = 1
  })
}
