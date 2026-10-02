// Utilitários dos scripts de desenvolvimento (somente localnet): fixtures, scenario e scan:once.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getAddressEncoder,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Instruction,
  type KeyPairSigner,
  type Signature,
} from '@solana/kit'
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget'
import { failureReason } from '../src/api/errors'
import type { Deployment } from '../src/config/deployment'

export const RPC_URL = process.env.AVEO_RPC_URL ?? 'http://127.0.0.1:8899'
export const WS_URL = process.env.AVEO_WS_URL ?? 'ws://127.0.0.1:8900'

const here = path.dirname(fileURLToPath(import.meta.url))
export const DEV_DIR = path.resolve(here, '../.dev')
export const DEPLOYMENT_FILE = path.join(DEV_DIR, 'deployment.json')
export const WALLETS_FILE = path.join(DEV_DIR, 'wallets.json')

export const rpc = createSolanaRpc(RPC_URL)
export const rpcSubscriptions = createSolanaRpcSubscriptions(WS_URL)
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions })

/** Carteira sintética salva em .dev/wallets.json (formato de keypair da Solana CLI: 64 bytes). */
export interface DevWalletRecord {
  id: string
  label: string
  role: 'issuer' | 'verifier' | 'treasury' | 'investor'
  secretKey: number[]
}

export async function newDevWallet(id: string, label: string, role: DevWalletRecord['role']): Promise<{ record: DevWalletRecord; signer: KeyPairSigner }> {
  const seed = crypto.getRandomValues(new Uint8Array(32))
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed)
  const secretKey = [...seed, ...getAddressEncoder().encode(signer.address)]
  return { record: { id, label, role, secretKey }, signer }
}

export async function loadDevWallets(): Promise<Map<string, { record: DevWalletRecord; signer: KeyPairSigner }>> {
  const records = JSON.parse(readFileSync(WALLETS_FILE, 'utf8')) as { wallets: DevWalletRecord[] }
  const entries = await Promise.all(
    records.wallets.map(async (record) => [record.id, { record, signer: await createKeyPairSignerFromBytes(new Uint8Array(record.secretKey)) }] as const),
  )
  return new Map(entries)
}

export function loadDeployment(): Deployment {
  return JSON.parse(readFileSync(DEPLOYMENT_FILE, 'utf8')) as Deployment
}

export function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}

export class TxFailure extends Error {
  readonly logs: string[]
  constructor(message: string, logs: string[]) {
    super(message)
    this.logs = logs
  }
}

/** Assina com o pagador (e demais signers das instruções), envia e espera a confirmação. */
export async function send(payer: KeyPairSigner, instructions: Instruction[], units = 400_000): Promise<Signature> {
  const { value: blockhash } = await rpc.getLatestBlockhash().send()
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions([getSetComputeUnitLimitInstruction({ units }), ...instructions], m),
  )
  const signed = await signTransactionMessageWithSigners(message)
  try {
    await sendAndConfirm(signed as Parameters<typeof sendAndConfirm>[0], { commitment: 'confirmed' })
  } catch (error) {
    const logs = extractLogs(error)
    throw new TxFailure(error instanceof Error ? error.message : String(error), logs)
  }
  return getSignatureFromTransaction(signed)
}

function extractLogs(error: unknown): string[] {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const context = (current as { context?: { logs?: string[] } }).context
    if (context?.logs) return context.logs
    current = (current as { cause?: unknown }).cause
  }
  return []
}

export function describeFailure(error: unknown, hookProgramId: Parameters<typeof failureReason>[2]): string {
  if (error instanceof TxFailure) return failureReason(null, error.logs, hookProgramId).code
  return error instanceof Error ? error.message : String(error)
}

export const encodeAddress = (value: Parameters<ReturnType<typeof getAddressEncoder>['encode']>[0]) => getAddressEncoder().encode(value)

export function log(step: string, detail = ''): void {
  console.log(`• ${step}${detail ? `  ${detail}` : ''}`)
}
