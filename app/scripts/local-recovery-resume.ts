// Read a persisted synthetic receipt in a new process; never load keys or submit.
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { getBase58Encoder, isAddress, isSignature } from '@solana/kit'
import { AVEO_HOOK_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '../src/api/constants'
import { tokenAccountsFor } from '../src/api/transactions'
import { parseDeployment } from '../src/config/deployment'
import { requireLocalEndpoints, requireLocalGenesis } from './localnet-safety'

const fail = () => new Error('Read-only local recovery could not verify the receipt; check isolated validator identity and transaction history.')
function check(value: unknown): asserts value { if (!value) throw fail() }
function record(value: unknown): Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}
function rawAmount(value: unknown): bigint {
  check(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 20)
  const amount = BigInt(value)
  check(amount <= 18_446_744_073_709_551_615n)
  return amount
}

export function parseRecoveryReceipt(value: unknown) {
  const r = record(value)
  const allowed = ['version', 'scope', 'status', 'signature', 'mint', 'source', 'destination', 'amount',
    'signatures', 'submissions', 'confirmationReadFaults', 'before', 'after', 'confirmationSlot', 'balanceSlot', 'hookSuccess']
  check(Object.keys(r).every((key) => allowed.includes(key)))
  check(r.version === 1 && r.scope === 'localnet-synthetic' && ['pending', 'unknown', 'PASS'].includes(String(r.status)) &&
    r.amount === '1' && r.signatures === 1 && r.submissions === 1)
  check(typeof r.signature === 'string' && isSignature(r.signature))
  check(typeof r.mint === 'string' && isAddress(r.mint))
  check(typeof r.source === 'string' && isAddress(r.source))
  check(typeof r.destination === 'string' && isAddress(r.destination) && r.source !== r.destination)
  check(Array.isArray(r.before) && r.before.length === 2)
  const before = r.before.map(rawAmount).map(String)
  check(r.after === undefined || (Array.isArray(r.after) && r.after.length === 2))
  const after = r.after === undefined ? undefined : (r.after as unknown[]).map(rawAmount).map(String)
  return { signature: r.signature, mint: r.mint, source: r.source, destination: r.destination, amount: '1' as const, before, after }
}

export type SavedTransfer = ReturnType<typeof parseRecoveryReceipt>

/** Compare the actual transaction and its historical balance changes, not current balances. */
export function verifyRecordedTransfer(value: unknown, receipt: SavedTransfer, sourceAccount: string,
  destinationAccount: string, decimals: number) {
  const tx = record(value)
  check(Number.isSafeInteger(tx.slot) && Number(tx.slot) > 0)
  const transaction = record(tx.transaction)
  check(Array.isArray(transaction.signatures) && transaction.signatures.length === 1 && transaction.signatures[0] === receipt.signature)
  const message = record(transaction.message)
  check(Array.isArray(message.accountKeys) && Array.isArray(message.instructions))
  const meta = record(tx.meta)
  const loaded = meta.loadedAddresses == null ? { writable: [], readonly: [] } : record(meta.loadedAddresses)
  check(Array.isArray(loaded.writable) && Array.isArray(loaded.readonly))
  const keys = [...message.accountKeys, ...loaded.writable, ...loaded.readonly]
  check(keys.every((key) => typeof key === 'string' && isAddress(key)) && new Set(keys).size === keys.length)
  check(keys[0] === receipt.source && record(message.header).numRequiredSignatures === 1)
  const sourceIndex = keys.findIndex((key) => key === sourceAccount)
  const destinationIndex = keys.findIndex((key) => key === destinationAccount)
  check(sourceIndex >= 0 && destinationIndex >= 0 && sourceIndex !== destinationIndex)
  const instructions = message.instructions.map(record)
  const program = (ix: Record<string, unknown>) => {
    check(Number.isSafeInteger(ix.programIdIndex) && Number(ix.programIdIndex) >= 0)
    return keys[Number(ix.programIdIndex)]
  }
  const transfers = instructions.filter((ix) => program(ix) === TOKEN_2022_PROGRAM_ID)
  check(transfers.length === 1 && instructions.every((ix) =>
    program(ix) === TOKEN_2022_PROGRAM_ID || program(ix) === 'ComputeBudget111111111111111111111111111111'))
  const transfer = transfers[0]!
  check(Array.isArray(transfer.accounts) && typeof transfer.data === 'string')
  const accounts = transfer.accounts.map((index) => { check(Number.isSafeInteger(index) && Number(index) >= 0 && Number(index) < keys.length); return keys[Number(index)] })
  // Token-2022 TransferChecked: discriminator 12, little-endian u64 amount, decimals.
  // Decode raw bytes: jsonParsed can mislabel transfer-hook extras as multisig signers.
  const data = getBase58Encoder().encode(transfer.data)
  check(data.length === 10 && data[0] === 12 && data[1] === 1 && data.slice(2, 9).every((byte) => byte === 0) && data[9] === decimals &&
    accounts[0] === sourceAccount && accounts[1] === receipt.mint && accounts[2] === destinationAccount && accounts[3] === receipt.source)
  check(Array.isArray(meta.innerInstructions))
  const inner = meta.innerInstructions.map(record).filter((group) => group.index === instructions.indexOf(transfer))
  check(inner.length === 1 && Array.isArray(inner[0]!.instructions))
  const hookCalls = inner[0]!.instructions.map(record).filter((ix) => program(ix) === AVEO_HOOK_PROGRAM_ID)
  check(hookCalls.length === 1 && Array.isArray(hookCalls[0]!.accounts))
  const hookAccounts = hookCalls[0]!.accounts.map((index) => keys[Number(index)])
  check(hookAccounts[0] === sourceAccount && hookAccounts[1] === receipt.mint && hookAccounts[2] === destinationAccount && hookAccounts[3] === receipt.source)
  check(meta.err === null && Array.isArray(meta.logMessages) &&
    meta.logMessages.includes(`Program ${AVEO_HOOK_PROGRAM_ID} invoke [2]`) &&
    meta.logMessages.includes(`Program ${AVEO_HOOK_PROGRAM_ID} success`))
  const balance = (raw: unknown, index: number, owner: string) => {
    check(Array.isArray(raw))
    const matches = raw.map(record).filter((b) => b.accountIndex === index)
    check(matches.length === 1)
    const b = matches[0]!
    const token = record(b.uiTokenAmount)
    check(b.mint === receipt.mint && b.owner === owner && b.programId === TOKEN_2022_PROGRAM_ID &&
      token.decimals === decimals)
    return rawAmount(token.amount)
  }
  const before = [balance(meta.preTokenBalances, sourceIndex, receipt.source), balance(meta.preTokenBalances, destinationIndex, receipt.destination)]
  const after = [balance(meta.postTokenBalances, sourceIndex, receipt.source), balance(meta.postTokenBalances, destinationIndex, receipt.destination)]
  check(before[0]! - after[0]! === 1n && after[1]! - before[1]! === 1n)
  check(before.every((amount, i) => String(amount) === receipt.before[i]) &&
    (receipt.after === undefined || after.every((amount, i) => String(amount) === receipt.after![i])))
  return { scope: 'localnet-synthetic' as const, status: 'PASS' as const, signature: receipt.signature,
    mint: receipt.mint, source: receipt.source, destination: receipt.destination, amount: receipt.amount,
    slot: Number(tx.slot), before: before.map(String), after: after.map(String), signingCalls: 0, submissionCalls: 0 }
}

type ReadMethod = 'getGenesisHash' | 'getTransaction' | 'getSignatureStatuses'
/** Only read methods exist at this boundary; redirects and unbounded reads are forbidden. */
export async function recoveryRead(rpcUrl: string, method: ReadMethod, params: unknown[]) {
  check(['getGenesisHash', 'getTransaction', 'getSignatureStatuses'].includes(method))
  requireLocalEndpoints(rpcUrl, 'ws://127.0.0.1:8900')
  const response = await fetch(rpcUrl, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  check(response.ok)
  const body = record(await response.json())
  check(body.jsonrpc === '2.0' && body.id === 1 && !body.error && 'result' in body)
  return body.result
}

export async function readPinnedTransaction(rpcUrl: string, expected: string, signature: string,
  read: typeof recoveryRead = recoveryRead) {
  requireLocalEndpoints(rpcUrl, 'ws://127.0.0.1:8900')
  requireLocalGenesis(expected, expected)
  check(isSignature(signature))
  const genesis = await read(rpcUrl, 'getGenesisHash', [])
  check(typeof genesis === 'string')
  requireLocalGenesis(genesis, expected)
  const transaction = await read(rpcUrl, 'getTransaction', [signature,
    { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }])
  const statuses = record(await read(rpcUrl, 'getSignatureStatuses', [[signature], { searchTransactionHistory: true }]))
  check(Array.isArray(statuses.value) && statuses.value.length === 1)
  const status = record(statuses.value[0])
  check(status.err === null && ['confirmed', 'finalized'].includes(String(status.confirmationStatus)) &&
    status.slot === record(transaction).slot)
  return { genesis, transaction }
}

export function readPublicReceiptFile(file: string): unknown {
  check(path.isAbsolute(file))
  check(path.basename(file) === 'deployment.json' || /^local-recovery-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/.test(path.basename(file)))
  const actual = realpathSync(file)
  const relative = path.relative(realpathSync(tmpdir()), actual)
  check(relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  const stats = lstatSync(file)
  check(stats.isFile() && !stats.isSymbolicLink() && stats.size > 0 && stats.size <= 65_536)
  return JSON.parse(readFileSync(actual, 'utf8'))
}

export async function main() {
  const rpcUrl = process.env.AVEO_RPC_URL ?? 'http://127.0.0.1:8899'
  requireLocalEndpoints(rpcUrl, process.env.AVEO_WS_URL ?? 'ws://127.0.0.1:8900')
  const expected = process.env.AVEO_LOCAL_GENESIS_HASH
  check(expected && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(expected))
  const file = process.argv[2]
  check(file && path.basename(file) !== 'deployment.json')
  const receipt = parseRecoveryReceipt(readPublicReceiptFile(file))
  const directory = path.dirname(realpathSync(file))
  const deployment = parseDeployment(readPublicReceiptFile(path.join(directory, 'deployment.json')),
    { cluster: 'localnet', programId: AVEO_HOOK_PROGRAM_ID })
  check(deployment.cluster === 'localnet')
  const assets = deployment.assets.filter((a) => a.id === 'alfa')
  const xs = deployment.wallets.filter((w) => w.id === 'X')
  const treasuries = deployment.wallets.filter((w) => w.id === 'treasury')
  check(assets.length === 1 && assets[0]!.mint === receipt.mint &&
    xs.length === 1 && xs[0]!.role === 'investor' && xs[0]!.address === receipt.source &&
    treasuries.length === 1 && treasuries[0]!.role === 'treasury' && treasuries[0]!.address === receipt.destination)
  const asset = assets[0]!
  const [sourceAccount, destinationAccount] = await tokenAccountsFor(receipt.mint, [receipt.source, receipt.destination])
  const { genesis, transaction } = await readPinnedTransaction(rpcUrl, expected, receipt.signature)
  const evidence = verifyRecordedTransfer(transaction, receipt, sourceAccount!, destinationAccount!, asset.decimals)
  const output = path.join(directory, `local-recovery-resumed-${randomUUID()}.json`)
  writeFileSync(output, JSON.stringify({ ...evidence, genesis }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(`PASS local-recovery-resume: ${output}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error(fail().message); process.exitCode = 1 })
}
