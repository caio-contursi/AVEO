// Dedicated synthetic devnet bootstrap. No local or personal wallet loading path exists.
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { getTransferSolInstruction } from '@solana-program/system'
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget'
import { appendTransactionMessageInstructions, compileTransaction, createKeyPairSignerFromPrivateKeyBytes,
  createDefaultRpcTransport, createSolanaRpcFromTransport, createTransactionMessage, getAddressEncoder, getBase64EncodedWireTransaction,
  getSignatureFromTransaction, isSignature, setTransactionMessageFeePayerSigner,
  isSolanaError, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  SolanaError,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED,
  setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners,
  type Address, type Instruction, type KeyPairSigner, type Rpc, type Signature, type SolanaRpcApi } from '@solana/kit'
import { AVEO_DEVNET_HOOK_PROGRAM_ID, SAS_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '../src/api/constants'
import type { ApiContext } from '../src/api/context'
import { messageFingerprint, verifySubmissionMessage } from '../src/api/submission-proof'
import type { Deployment } from '../src/config/deployment'
import { DEVNET_GENESIS_HASH } from './devnet-preflight'
import { bounded } from './local-recovery-check'
import { parsePublicManifest } from './public-manifest'

const fail = () => new Error('Synthetic devnet bootstrap stopped. Check program deployment, test funding and private run evidence; do not blindly rerun or resend.')
function check(value: unknown): asserts value { if (!value) throw fail() }

/** Call inside the exclusive runtime gate; a monotonic clock avoids wall-clock adjustments. */
export function createSerialMutationPacer(intervalMs: number): () => Promise<void> {
  check(Number.isSafeInteger(intervalMs) && intervalMs >= 0 && intervalMs <= 10_000)
  let next = 0
  return async () => {
    const delay = Math.max(0, next - performance.now())
    if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay))
    next = performance.now() + intervalMs
  }
}

/** Transport retries apply only to reads; signed transaction broadcasts never use this helper. */
async function readWithRetry<T>(read: (signal: AbortSignal) => Promise<T>, timeout = 20_000): Promise<T> {
  return bounded(async (signal) => {
    while (!signal.aborted) {
      try {
        const result = await read(signal)
        check(!signal.aborted)
        return result
      } catch (error) {
        const transient = isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)
          ? [429, 502, 503, 504].includes(error.context.statusCode)
          : isSolanaError(error, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED)
        if (signal.aborted || !transient) throw fail()
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 1000))
    }
    throw fail()
  }, timeout)
}

/** Normalize only the public endpoint's nonstandard rate-limit code before SDK decoding. */
export function createDevnetRpc(url: string, retryReads = false): Rpc<SolanaRpcApi> {
  validateDevnetEndpoints(url, 'wss://api.devnet.solana.com')
  const transport = createDefaultRpcTransport({ url })
  const normalize = async <TResponse>(config: Parameters<typeof transport>[0]): Promise<TResponse> => {
    const response = await transport<TResponse>(config)
    if (response && typeof response === 'object' && 'error' in response) {
      const error = response.error
      if (error && typeof error === 'object' && 'code' in error &&
        (error.code === 429 || error.code === 429n)) {
        throw new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
          { statusCode: 429, message: 'Devnet RPC rate limit', headers: new Headers() })
      }
    }
    return response
  }
  const reads = new Set(['getGenesisHash', 'getAccountInfo', 'getMultipleAccounts', 'getBalance',
    'getLatestBlockhash', 'getSignatureStatuses', 'getTransaction', 'getMinimumBalanceForRentExemption',
    'getSlot', 'getBlockHeight', 'simulateTransaction'])
  return createSolanaRpcFromTransport(async <TResponse>(config: Parameters<typeof transport>[0]): Promise<TResponse> => {
    const payload = config.payload
    const method = payload && typeof payload === 'object' && 'method' in payload ? payload.method : undefined
    if (!retryReads || typeof method !== 'string' || !reads.has(method)) return normalize<TResponse>(config)
    return readWithRetry(async (signal) => {
      const combined = config.signal ? AbortSignal.any([signal, config.signal]) : signal
      const response = await normalize<TResponse>({ ...config, signal: combined })
      check(!combined.aborted)
      return response
    })
  })
}

export interface DevnetWalletRecord {
  id: string
  label: string
  role: 'issuer' | 'verifier' | 'treasury' | 'investor'
  secretKey: number[]
}
export interface DevnetRuntime {
  rpc: Rpc<SolanaRpcApi>
  rpcUrl: string
  wsUrl: string
  directory: string
  newWallet: (id: string, label: string, role: DevnetWalletRecord['role']) => Promise<{ record: DevnetWalletRecord; signer: KeyPairSigner }>
  fund: (wallet: Address, amount: bigint) => Promise<void>
  send: (payer: KeyPairSigner, instructions: Instruction[], units?: number) => Promise<Signature>
  writePublicDeployment: (deployment: Deployment) => void
}

export function validateDevnetEndpoints(rpcUrl: string, wsUrl: string): void {
  try {
    const rpc = new URL(rpcUrl), ws = new URL(wsUrl)
    for (const endpoint of [rpc, ws]) check(!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash && endpoint.pathname === '/')
    // The first reviewed public-network signer supports just the official endpoint.
    check(rpcUrl === 'https://api.devnet.solana.com' && wsUrl === 'wss://api.devnet.solana.com')
  } catch { throw fail() }
}

export function validateDevnetDirectory(directory: string): string {
  try {
    check(path.isAbsolute(directory) && path.resolve(directory) === directory && realpathSync(directory) === directory)
    const relative = path.relative(realpathSync(tmpdir()), directory)
    const stat = lstatSync(directory)
    check(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) &&
      stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0)
    return directory
  } catch { throw fail() }
}

/** Append-only snapshots: a torn new line never destroys previously durable keys/signatures. */
function privateJson(file: string, initial: unknown) {
  const initialFd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  try { writeFileSync(initialFd, JSON.stringify(initial) + '\n'); fsyncSync(initialFd) } finally { closeSync(initialFd) }
  const original = lstatSync(file)
  const parent = lstatSync(path.dirname(file))
  const parentFd = openSync(path.dirname(file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { fsyncSync(parentFd) } finally { closeSync(parentFd) }
  return (value: unknown) => {
    let fd: number | undefined
    try {
      const directory = lstatSync(path.dirname(file))
      check(directory.isDirectory() && !directory.isSymbolicLink() && directory.ino === parent.ino && directory.dev === parent.dev && (directory.mode & 0o077) === 0)
      fd = openSync(file, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW)
      const current = fstatSync(fd)
      check(current.isFile() && current.nlink === 1 && (current.mode & 0o077) === 0 && current.ino === original.ino && current.dev === original.dev)
      const raw = JSON.stringify(value) + '\n'
      const bytes = Buffer.from(raw)
      check(bytes.length <= 1_048_576 && current.size + bytes.length <= 16_777_216)
      writeFileSync(fd, raw)
      fsyncSync(fd)
      const readback = Buffer.alloc(bytes.length)
      check(readSync(fd, readback, 0, readback.length, current.size) === bytes.length && readback.equals(bytes) &&
        fstatSync(fd).size === current.size + bytes.length)
    } catch { throw fail() } finally { if (fd !== undefined) closeSync(fd) }
  }
}

export async function verifyDevnetRuntimePrograms(rpc: Rpc<SolanaRpcApi>): Promise<void> {
  await bounded(async (signal) => {
    check(await rpc.getGenesisHash().send({ abortSignal: signal }) === DEVNET_GENESIS_HASH)
    const result = await rpc.getMultipleAccounts([AVEO_DEVNET_HOOK_PROGRAM_ID, SAS_PROGRAM_ID, TOKEN_2022_PROGRAM_ID],
      { commitment: 'confirmed', encoding: 'base64', dataSlice: { offset: 0, length: 0 } }).send({ abortSignal: signal })
    check(!signal.aborted && result.value.length === 3 && result.value.every((account) => account?.executable === true &&
      ['BPFLoaderUpgradeab1e11111111111111111111111', 'BPFLoader2111111111111111111111111111111111'].includes(account.owner)))
  }, 15_000)
}

/** Injected RPC supports offline tests; CLI never exposes this injection. */
export async function createDevnetRuntime(options: { directory: string; rpcUrl: string; wsUrl: string; externalIssuerFunding?: boolean },
  dependencies?: { rpc: Rpc<SolanaRpcApi>; onExternalFundingRequired?: (wallet: Address) => void }): Promise<DevnetRuntime> {
  try {
    validateDevnetEndpoints(options.rpcUrl, options.wsUrl)
    check(options.externalIssuerFunding === undefined || typeof options.externalIssuerFunding === 'boolean')
    const directory = validateDevnetDirectory(options.directory)
    const rpc = dependencies?.rpc ?? createDevnetRpc(options.rpcUrl, true)
    // Fail before any private artifact, key generation, faucet request or signature.
    await verifyDevnetRuntimePrograms(rpc)
    const journal: { scope: string; status: string; operations: Record<string, unknown>[] } =
      { scope: 'devnet-synthetic-bootstrap', status: 'preparing', operations: [] }
    const writeJournal = privateJson(path.join(directory, 'devnet-run.jsonl'), journal)
    const records: DevnetWalletRecord[] = []
    const writeWallets = privateJson(path.join(directory, 'devnet-wallets.jsonl'), { scope: 'devnet-synthetic-only', wallets: records })
    const wallets = new Map<string, KeyPairSigner>()
    // Real bootstrap mutations are paced; injected offline RPC never incurs real waits.
    const paceMutation = createSerialMutationPacer(dependencies?.rpc ? 0 : 5000)
    let funder: KeyPairSigner | undefined
    let readFloor = 0n
    let networkMismatchObserved = false
    let blocked = false, busy = false
    const persist = () => writeJournal(journal)
    const pin = async () => {
      const genesis = await readWithRetry((signal) => rpc.getGenesisHash().send({ abortSignal: signal }))
      if (genesis !== DEVNET_GENESIS_HASH) networkMismatchObserved = true
      check(genesis === DEVNET_GENESIS_HASH)
    }
    const exclusive = async <T>(operation: () => Promise<T>): Promise<T> => {
      check(!blocked && !busy && journal.status === 'preparing')
      busy = true
      try { return await operation() } catch {
        blocked = true
        journal.status = 'stopped'
        try { persist() } catch { /* Existing exclusive run file still prevents rerun. */ }
        throw fail()
      } finally { busy = false }
    }
    const confirmed = async (signature: Signature, onFailure?: () => void) => bounded(async (signal) => {
      while (!signal.aborted) {
        const { value } = await readWithRetry((readSignal) => rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send({ abortSignal: readSignal }), 10_000)
        check(!signal.aborted)
        const status = value[0]
        if (status && status.err !== null) { onFailure?.(); throw fail() }
        if (status && ['confirmed', 'finalized'].includes(status.confirmationStatus ?? '')) {
          check(status.err === null && Number.isSafeInteger(Number(status.slot)) && Number(status.slot) > 0)
          return status.slot
        }
        await new Promise<void>((resolve) => { setTimeout(resolve, 1000) })
      }
      throw fail()
    }, 30_000)
    const send = async (payer: KeyPairSigner, instructions: Instruction[], units = 400_000): Promise<Signature> => {
      check([...wallets.values()].includes(payer) && instructions.length > 0 && Number.isSafeInteger(units) && units > 0 && units <= 1_400_000)
      for (const instruction of instructions) for (const account of instruction.accounts ?? []) {
        if (account.role === 2 || account.role === 3) check([...wallets.values()].some((wallet) => wallet.address === account.address))
        if ('signer' in account) check([...wallets.values()].includes(account.signer as KeyPairSigner))
      }
      await paceMutation()
      await pin()
      const operation: Record<string, unknown> = { kind: 'transaction', phase: 'preparing', payer: payer.address }
      journal.operations.push(operation); persist()
      let acknowledged: { signature: Signature; fingerprint: string } | undefined
      const originalProof = (signature: Signature, fingerprint: string) => bounded(async (signal) => {
        let observerOpen = true
        // Even unsupported error metadata must latch a conservative stop, not disappear as missing proof.
        const observingRpc = new Proxy(rpc, {
          get(target, property, receiver) {
            if (property !== 'getTransaction') return Reflect.get(target, property, receiver)
            return (...args: Parameters<typeof rpc.getTransaction>) => {
              const request = rpc.getTransaction(...args)
              return { send: async (options: Parameters<typeof request.send>[0]) => {
                const result = await request.send(options)
                if (observerOpen && !signal.aborted && !options?.abortSignal?.aborted &&
                  result?.meta && Object.hasOwn(result.meta, 'err') && result.meta.err !== null) {
                  operation.chainFailureObserved = true
                }
                return result
              } }
            }
          },
        })
        try { while (!signal.aborted) {
          const observed = await verifySubmissionMessage({ commitment: 'confirmed', rpc: observingRpc } as ApiContext, signature, fingerprint)
          check(!signal.aborted && !operation.chainFailureObserved)
          if (observed) {
            check(!signal.aborted)
            if (observed.status === 'failed') operation.chainFailureObserved = true
            check(observed.status === 'confirmed')
            return observed
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 1000))
        }
        throw fail()
        } finally { observerOpen = false }
      }, 30_000)
      try {
        const latest = await readWithRetry((signal) => rpc.getLatestBlockhash({ commitment: 'confirmed', minContextSlot: readFloor }).send({ abortSignal: signal }))
        check(latest.context.slot >= readFloor)
        const blockhash = latest.value
        const message = appendTransactionMessageInstructions([getSetComputeUnitLimitInstruction({ units }), ...instructions],
          setTransactionMessageLifetimeUsingBlockhash(blockhash, setTransactionMessageFeePayerSigner(payer, createTransactionMessage({ version: 0 }))))
        const fingerprint = await messageFingerprint(compileTransaction(message).messageBytes)
        operation.phase = 'signing'; operation.messageFingerprint = fingerprint; persist()
        const signed = await signTransactionMessageWithSigners(message)
        const signature = getSignatureFromTransaction(signed)
        operation.signature = signature; operation.phase = 'signed'; persist()
        const wire = getBase64EncodedWireTransaction(signed)
        operation.phase = 'simulating'; persist()
        const simulation = await readWithRetry((signal) => rpc.simulateTransaction(wire,
          { encoding: 'base64', commitment: 'confirmed', sigVerify: true, minContextSlot: latest.context.slot }).send({ abortSignal: signal }))
        if (simulation.value.err !== null) {
          operation.simulationVerdict = typeof simulation.value.err === 'string' &&
            ['BlockhashNotFound', 'AccountNotFound', 'InsufficientFundsForFee'].includes(simulation.value.err)
            ? simulation.value.err : 'Rejected'
          persist()
        }
        check(simulation.value.err === null)
        operation.phase = 'checking-network'; persist()
        await pin()
        operation.phase = 'submitting'; persist()
        const returned = await bounded(async (signal) => {
          try {
            return await rpc.sendTransaction(wire,
              { encoding: 'base64', preflightCommitment: 'confirmed', minContextSlot: latest.context.slot, skipPreflight: false, maxRetries: 0n }).send({ abortSignal: signal })
          } catch (error) {
            if (!signal.aborted && isSolanaError(error)) {
              operation.submissionRpcCode = Number(error.context.__code)
              if (isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) operation.submissionHttpStatus = error.context.statusCode
            }
            throw error
          }
        }, 15_000)
        check(returned === signature)
        acknowledged = { signature, fingerprint }
        operation.phase = 'submitted'; persist()
        await confirmed(signature, () => { operation.chainFailureObserved = true })
        operation.phase = 'verifying'; persist()
        // RPC transaction indexing can lag confirmation. Retry reads, never the submission.
        const proof = await originalProof(signature, fingerprint)
        await pin()
        check(!operation.chainFailureObserved && !networkMismatchObserved)
        readFloor = BigInt(proof.slot) > readFloor ? BigInt(proof.slot) : readFloor
        operation.phase = 'confirmed'; operation.slot = proof.slot; persist()
        return signature
      } catch {
        // An acknowledged signature may be reconciled by exact-message reads, never recreated.
        if (acknowledged && !networkMismatchObserved && !operation.chainFailureObserved) {
          operation.phase = 'reconciling'; persist()
          try {
            const proof = await originalProof(acknowledged.signature, acknowledged.fingerprint)
            await pin()
            check(!operation.chainFailureObserved && !networkMismatchObserved)
            readFloor = BigInt(proof.slot) > readFloor ? BigInt(proof.slot) : readFloor
            operation.phase = 'confirmed'; operation.slot = proof.slot; persist()
            return acknowledged.signature
          } catch { /* Preserve the original signature and stop without a second broadcast. */ }
        }
        operation.phase = 'unknown'; persist(); throw fail()
      }
    }
    return {
      rpc, rpcUrl: options.rpcUrl, wsUrl: options.wsUrl, directory,
      newWallet: (id, label, role) => exclusive(async () => {
        check(/^[A-Za-z0-9_-]{1,48}$/.test(id) && label.length > 0 && label.length <= 128 &&
          ['issuer', 'verifier', 'treasury', 'investor'].includes(role) && records.length < 32 && !records.some((record) => record.id === id))
        const seed = crypto.getRandomValues(new Uint8Array(32))
        const signer = await createKeyPairSignerFromPrivateKeyBytes(seed)
        const record = { id, label, role, secretKey: [...seed, ...getAddressEncoder().encode(signer.address)] }
        records.push(record)
        writeWallets({ scope: 'devnet-synthetic-only', wallets: records })
        wallets.set(id, signer)
        return { record, signer }
      }),
      fund: (wallet, amount) => exclusive(async () => {
        const recipient = [...wallets.values()].find((entry) => entry.address === wallet)
        check(recipient && amount > 0n && amount <= 1_000_000_000n)
        if (funder) { check(funder !== recipient); await send(funder, [getTransferSolInstruction({ source: funder, destination: wallet, amount })]); return }
        check(wallets.get('issuer') === recipient)
        await pin()
        const before = await bounded((signal) => rpc.getBalance(wallet, { commitment: 'confirmed' }).send({ abortSignal: signal }), 10_000)
        if (options.externalIssuerFunding) {
          const operation: Record<string, unknown> = { kind: 'external-funding-observation', phase: 'waiting', recipient: wallet, lamports: String(amount) }
          journal.operations.push(operation); persist()
          // Only the newly generated issuer's public address is exposed; no external key is loaded.
          const notify = dependencies?.onExternalFundingRequired ?? ((address: Address) => console.log(`Awaiting synthetic devnet issuer funding: ${address}`))
          notify(wallet)
          const observed = await bounded(async (signal) => {
            while (!signal.aborted) {
              const balance = await rpc.getBalance(wallet, { commitment: 'confirmed', minContextSlot: before.context.slot }).send({ abortSignal: signal })
              check(balance.context.slot >= before.context.slot)
              if (balance.value >= amount) return balance
              await new Promise<void>((resolve) => setTimeout(resolve, 1000))
            }
            throw fail()
          }, 60_000)
          await pin()
          operation.phase = 'confirmed'; operation.slot = Number(observed.context.slot); persist()
          readFloor = observed.context.slot
          funder = recipient
          return
        }
        const operation: Record<string, unknown> = { kind: 'airdrop', phase: 'requesting', recipient: wallet, lamports: String(amount) }
        journal.operations.push(operation); persist()
        try {
          await pin()
          const signature = await bounded((signal) => rpc.requestAirdrop(wallet, amount as Parameters<typeof rpc.requestAirdrop>[1],
            { commitment: 'confirmed' }).send({ abortSignal: signal }), 15_000)
          check(isSignature(signature))
          operation.signature = signature; operation.phase = 'submitted'; persist()
          const slot = await confirmed(signature)
          const after = await bounded((signal) => rpc.getBalance(wallet, { commitment: 'confirmed', minContextSlot: slot }).send({ abortSignal: signal }), 10_000)
          check(after.value >= before.value + amount)
          check(after.context.slot >= slot)
          await pin()
          operation.phase = 'confirmed'; operation.slot = Number(slot); persist()
          readFloor = after.context.slot
          funder = recipient
        } catch { operation.phase = 'unknown'; persist(); throw fail() }
      }),
      send: (payer, instructions, units) => exclusive(() => send(payer, instructions, units)),
      writePublicDeployment: (deployment) => {
        try {
          check(!blocked && !busy && journal.status === 'preparing' && journal.operations.length > 0 &&
            journal.operations.every((operation) => operation.phase === 'confirmed'))
          const manifest = parsePublicManifest(deployment)
          check(manifest.programs.aveoHook === AVEO_DEVNET_HOOK_PROGRAM_ID && manifest.issuer === wallets.get('issuer')?.address &&
            [...manifest.wallets.map((wallet) => wallet.address), ...manifest.assets.map((asset) => asset.mint),
              ...manifest.verifiers.map((verifier) => verifier.authority)].every((address) => [...wallets.values()].some((wallet) => wallet.address === address)))
          writeFileSync(path.join(directory, 'deployment.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
          journal.status = 'complete'; persist()
        } catch { blocked = true; throw fail() }
      },
    }
  } catch { throw fail() }
}
