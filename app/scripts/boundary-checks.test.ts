import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  generateKeyPairSigner, getAddressDecoder, getBase58Decoder,
  signature as parseSignature, type Address, type Instruction, type KeyPairSigner,
} from '@solana/kit'
import { getTokenEncoder, parseTransferCheckedInstruction } from '@solana-program/token-2022'
import { readAccounts } from '../src/api/accounts'
import { TOKEN_2022_PROGRAM_ID } from '../src/api/constants'
import type { ApiContext } from '../src/api/context'
import { confirmSignature } from '../src/api/transactions'
import {
  BOUNDARY_STAGES, expectBoundaryDelta, expectInsufficientFunds, runBoundaryChecks,
  type BoundaryCheckOptions,
} from './boundary-checks'

const state = vi.hoisted(() => ({ instructions: [] as Instruction[], sends: 0 }))
vi.mock('../src/api/accounts', () => ({ readAccounts: vi.fn() }))
vi.mock('../src/api/transactions', () => ({ confirmSignature: vi.fn() }))
vi.mock('@solana-program/token-2022', async (importOriginal) => ({
  ...await importOriginal<typeof import('@solana-program/token-2022')>(),
  resolveExtraAccountMetasForExecute: vi.fn(async () => [
    { address: '11111111111111111111111111111111', role: 0 },
  ]),
}))
vi.mock('@solana/kit', async (importOriginal) => ({
  ...await importOriginal<typeof import('@solana/kit')>(),
  signTransactionMessageWithSigners: vi.fn(async (message: { instructions: Instruction[] }) => {
    state.instructions = message.instructions
    return {}
  }),
  getBase64EncodedWireTransaction: vi.fn(() => 'fake-wire'),
  getSignatureFromTransaction: vi.fn(() => parseSignature(getBase58Decoder().decode(new Uint8Array(64).fill(9)))),
}))

const address = (byte: number) => getAddressDecoder().decode(new Uint8Array(32).fill(byte))
const insufficientLogs = [
  `Program ${TOKEN_2022_PROGRAM_ID} invoke [1]`,
  'Program log: Error: insufficient funds',
  `Program ${TOKEN_2022_PROGRAM_ID} failed: custom program error: 0x1`,
]
const ledgerError = { InstructionError: [1, { Custom: 1 }] }

beforeEach(() => { vi.clearAllMocks(); state.sends = 0; state.instructions = [] })

describe('boundary amount and conservation checks', () => {
  it.each([
    [[10n, 4n], [10n, 4n], 0n], [[10n, 4n], [0n, 14n], 10n], [[10n, 0n], [9n, 1n], 1n],
  ] as const)('accepts correct boundary delta', (before, after, amount) => {
    expect(() => expectBoundaryDelta(before, after, amount)).not.toThrow()
  })
  it.each([
    [[10n], [10n, 0n], 0n], [[10n, 0n], [9n, 0n], 1n],
    [[10n, 0n], [10n, 1n], 1n], [[10n, 0n], [-1n, 11n], 11n],
    [[10n, 0n], [11n, -1n], -1n],
  ] as const)('rejects malformed, nonconserving or negative balances', (before, after, amount) => {
    expect(() => expectBoundaryDelta(before, after, amount)).toThrow()
  })
})

describe('canonical ledger InsufficientFunds matcher', () => {
  it('accepts only the raw transfer index and installed canonical custom code', () => {
    expect(() => expectInsufficientFunds(ledgerError, insufficientLogs)).not.toThrow()
    expect(() => expectInsufficientFunds({ InstructionError: [1n, { Custom: 1n }] }, insufficientLogs)).not.toThrow()
  })
  it.each([null, {}, { InstructionError: [0, { Custom: 1 }] }, { InstructionError: [1, { Custom: 6008 }] },
    { InstructionError: [1, 'InsufficientFunds'] }, { InstructionError: [1, { Custom: '1' }] }])('rejects another error %j', (error) => {
    expect(() => expectInsufficientFunds(error, insufficientLogs)).toThrow()
  })
  it('rejects simulation-only, missing diagnostics and a nested hook custom error', () => {
    expect(() => expectInsufficientFunds(ledgerError, [])).toThrow()
    expect(() => expectInsufficientFunds(ledgerError, insufficientLogs.slice(1))).toThrow()
    expect(() => expectInsufficientFunds(ledgerError, insufficientLogs.filter((line) => !line.startsWith('Program log:')))).toThrow()
    expect(() => expectInsufficientFunds(ledgerError, [
      ...insufficientLogs, `Program ${address(5)} failed: custom program error: 0x1`,
    ])).toThrow()
  })
})

async function fakeLedger() {
  const treasurySigner = await generateKeyPairSigner()
  const xSigner = await generateKeyPairSigner()
  const mint = address(7)
  const { findAssociatedTokenPda } = await import('@solana-program/token-2022')
  const [treasury] = await findAssociatedTokenPda({ owner: treasurySigner.address, mint, tokenProgram: TOKEN_2022_PROGRAM_ID })
  const [x] = await findAssociatedTokenPda({ owner: xSigner.address, mint, tokenProgram: TOKEN_2022_PROGRAM_ID })
  const tokens = new Map<Address, { owner: Address; amount: bigint }>([
    [treasury, { owner: treasurySigner.address, amount: 100n }], [x, { owner: xSigner.address, amount: 5n }],
  ])
  let slot = 10
  let failed = false
  let unknown = false
  let auxiliary: Address | undefined
  const sendTransaction = vi.fn(() => ({ send: async () => {
    state.sends += 1
    slot += 1
    failed = false
    for (const ix of state.instructions.slice(1)) {
      if (ix.programAddress !== TOKEN_2022_PROGRAM_ID) continue
      if (ix.data![0] === 12) {
        const parsed = parseTransferCheckedInstruction(ix as Parameters<typeof parseTransferCheckedInstruction>[0])
        const source = tokens.get(parsed.accounts.source.address)!
        const destination = tokens.get(parsed.accounts.destination.address)!
        if (source.amount < parsed.data.amount) { failed = true; break }
        source.amount -= parsed.data.amount
        destination.amount += parsed.data.amount
      } else if (ix.data![0] === 18) {
        auxiliary = ix.accounts![0]!.address
        tokens.set(auxiliary, { owner: treasurySigner.address, amount: 0n })
      } else if (ix.data![0] === 9) {
        const account = ix.accounts![0]!.address
        expect(tokens.get(account)?.amount).toBe(0n)
        tokens.delete(account)
      }
    }
    return parseSignature(getBase58Decoder().decode(new Uint8Array(64).fill(9)))
  } }))
  const ctx = { cluster: 'localnet', rpcUrl: 'http://127.0.0.1:8899', commitment: 'confirmed', programId: address(8),
    rpc: {
      getLatestBlockhash: () => ({ send: async () => ({ value: { blockhash: address(1), lastValidBlockHeight: 500n } }) }),
      sendTransaction,
      getMinimumBalanceForRentExemption: () => ({ send: async () => 1234n }),
      getSignatureStatuses: () => ({ send: async () => ({ value: [{ slot: BigInt(slot), confirmationStatus: 'confirmed', err: failed ? ledgerError : null }] }) }),
    },
  } as unknown as ApiContext
  vi.mocked(readAccounts).mockImplementation(async (_ctx, addresses, minSlot) => {
    expect(slot).toBeGreaterThanOrEqual(minSlot ?? 0)
    return { slot, accounts: addresses.map((account) => {
      const token = tokens.get(account)
      return token ? { address: account, owner: TOKEN_2022_PROGRAM_ID, executable: false, lamports: 1234n,
        data: new Uint8Array(getTokenEncoder().encode({ mint, owner: token.owner, amount: token.amount,
          delegate: null, state: 1, isNative: null, delegatedAmount: 0n, closeAuthority: null,
          extensions: [{ __kind: 'TransferHookAccount', transferring: false }] })) } : null
    }) }
  })
  vi.mocked(confirmSignature).mockImplementation(async () => unknown
    ? { status: 'unknown', logs: [] }
    : { status: failed ? 'failed' : 'confirmed', slot, logs: failed ? insufficientLogs : [] })
  const options: BoundaryCheckOptions = { ctx, treasurySigner, xSigner, walletX: xSigner.address,
    asset: { id: 'alfa', label: 'Alfa', symbol: 'ALFA', mint, decimals: 0 }, loopbackAuthorized: true,
    evidence: vi.fn(), passStage: vi.fn() }
  return { options, tokens, treasury, x, sendTransaction,
    auxiliary: () => auxiliary, setUnknown: () => { unknown = true } }
}

describe('fake-only acceptance orchestration', () => {
  it('executes all boundaries, creates a distinct same-owner account, restores tokens and closes it', async () => {
    const ledger = await fakeLedger()
    await runBoundaryChecks(ledger.options)
    expect(vi.mocked(ledger.options.passStage).mock.calls.flat()).toEqual([...BOUNDARY_STAGES])
    expect(ledger.tokens.get(ledger.treasury)?.amount).toBe(100n)
    expect(ledger.tokens.get(ledger.x)?.amount).toBe(5n)
    expect(ledger.auxiliary()).toBeDefined()
    expect(ledger.auxiliary()).not.toBe(ledger.treasury)
    expect(ledger.tokens.has(ledger.auxiliary()!)).toBe(false)
    expect(state.sends).toBe(9)
    const records = vi.mocked(ledger.options.evidence).mock.calls.map(([record]) => record)
    expect(records.some((record) => record.status === 'failed' && record.signature && record.slot)).toBe(true)
    expect(records.filter((record) => record.validatorError !== undefined)).toEqual([
      expect.objectContaining({ status: 'failed', validatorError: 'TokenInsufficientFunds' }),
      expect.objectContaining({ status: 'failed', validatorError: 'TokenInsufficientFunds' }),
    ])
    expect(records.filter((record) => record.status === 'confirmed').every((record) => record.validatorError === undefined)).toBe(true)
    expect(records.filter((record) => record.source === ledger.treasury && record.destination === ledger.x
      && record.amount !== undefined).map((record) => record.amount)).toEqual(['0', '101', '18446744073709551615', '100'])
    expect(records.filter((record) => record.accepted === false)).toEqual([
      expect.objectContaining({ amount: '101', before: ['100', '5'], after: ['100', '5'] }),
      expect.objectContaining({ amount: '18446744073709551615', before: ['100', '5'], after: ['100', '5'] }),
    ])
    expect(records.some((record) => record.source === ledger.treasury && record.destination === ledger.auxiliary()
      && record.before?.join() === '100,0' && record.after?.join() === '99,1')).toBe(true)
    expect(records.every((record) => !('logs' in record) && !('secretKey' in record))).toBe(true)
  })
  it('restores X after an assertion callback fails following the exact-balance send', async () => {
    const ledger = await fakeLedger()
    ledger.options.evidence = (record) => {
      if (record.after?.[0] === '0') throw new Error('Injected evidence failure')
    }
    await expect(runBoundaryChecks(ledger.options)).rejects.toThrow('Boundary acceptance')
    expect(ledger.tokens.get(ledger.treasury)?.amount).toBe(100n)
    expect(ledger.tokens.get(ledger.x)?.amount).toBe(5n)
  })
  it('does not emit a validator error label if canonical matching fails', async () => {
    const ledger = await fakeLedger()
    vi.spyOn(ledger.options.ctx.rpc, 'getSignatureStatuses').mockReturnValue({ send: async () => ({
      value: [{ slot: 12n, confirmationStatus: 'confirmed', err: { InstructionError: [1, { Custom: 6008 }] } }],
    }) } as unknown as ReturnType<ApiContext['rpc']['getSignatureStatuses']>)
    await expect(runBoundaryChecks(ledger.options)).rejects.toThrow('Boundary acceptance')
    expect(vi.mocked(ledger.options.evidence).mock.calls.every(([record]) => record.validatorError === undefined)).toBe(true)
    expect(state.sends).toBe(2)
  })
  it('returns auxiliary funds and rent even if same-owner stage reporting fails', async () => {
    const ledger = await fakeLedger()
    ledger.options.passStage = (stage) => {
      if (stage === BOUNDARY_STAGES[4]) throw new Error('Injected stage failure')
    }
    await expect(runBoundaryChecks(ledger.options)).rejects.toThrow('Boundary acceptance')
    expect(ledger.tokens.get(ledger.treasury)?.amount).toBe(100n)
    expect(ledger.tokens.has(ledger.auxiliary()!)).toBe(false)
  })
  it('still closes the emptied auxiliary account if cleanup evidence reporting fails', async () => {
    const ledger = await fakeLedger()
    ledger.options.evidence = (record) => {
      if (record.source === ledger.auxiliary() && record.amount === '1') throw new Error('Injected cleanup reporting failure')
    }
    await expect(runBoundaryChecks(ledger.options)).rejects.toThrow('Boundary acceptance')
    expect(ledger.tokens.get(ledger.treasury)?.amount).toBe(100n)
    expect(ledger.tokens.has(ledger.auxiliary()!)).toBe(false)
    expect(vi.mocked(ledger.options.passStage).mock.calls.flat()).not.toContain(BOUNDARY_STAGES[5])
  })
  it('does not replay transactions or attempt cleanup while confirmation remains unknown', async () => {
    const ledger = await fakeLedger()
    ledger.setUnknown()
    await expect(runBoundaryChecks(ledger.options)).rejects.toThrow('Boundary acceptance')
    expect(state.sends).toBe(1)
    expect(ledger.tokens.get(ledger.treasury)?.amount).toBe(100n)
  })
  it.each(['https://api.devnet.solana.com', 'http://localhost/proxy', 'http://localhost/?key=secret'])('rejects nonlocal contexts before I/O: %s', async (rpcUrl) => {
    const ledger = await fakeLedger()
    ledger.options.ctx.rpcUrl = rpcUrl
    await expect(runBoundaryChecks(ledger.options)).rejects.toThrow()
    expect(readAccounts).not.toHaveBeenCalled()
    expect(ledger.sendTransaction).not.toHaveBeenCalled()
  })
  it('requires parent authorization and a matching X signer before I/O', async () => {
    const ledger = await fakeLedger()
    await expect(runBoundaryChecks({ ...ledger.options, loopbackAuthorized: false as unknown as true })).rejects.toThrow('authorization')
    await expect(runBoundaryChecks({ ...ledger.options, xSigner: { address: address(3) } as KeyPairSigner })).rejects.toThrow('signer')
    expect(readAccounts).not.toHaveBeenCalled()
  })
})
