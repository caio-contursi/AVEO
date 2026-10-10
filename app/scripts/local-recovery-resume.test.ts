import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { getBase58Decoder } from '@solana/kit'
import { AVEO_HOOK_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '../src/api/constants'
import { parseRecoveryReceipt, readPinnedTransaction, readPublicReceiptFile, recoveryRead, verifyRecordedTransfer } from './local-recovery-resume'

vi.mock('./lib', () => { throw new Error('Key-loading library must never be imported') })
const address = (n: number) => `${'1'.repeat(31)}${n}`
const signature = '1'.repeat(64)
function fixture() {
  const claim = { version: 1, scope: 'localnet-synthetic', status: 'unknown', signature, mint: address(2),
    source: address(3), destination: address(4), amount: '1', signatures: 1, submissions: 1, before: ['49', '911'] }
  const receipt = parseRecoveryReceipt(claim)
  const sourceAccount = address(5), destinationAccount = address(6)
  const balance = (accountIndex: number, owner: string, amount: string) => ({ accountIndex, owner,
    mint: receipt.mint, programId: TOKEN_2022_PROGRAM_ID, uiTokenAmount: { amount, decimals: 0 } })
  const transaction = { slot: 959, transaction: { signatures: [signature], message: {
    header: { numRequiredSignatures: 1 },
    accountKeys: [receipt.source, sourceAccount, destinationAccount, receipt.mint, TOKEN_2022_PROGRAM_ID, AVEO_HOOK_PROGRAM_ID],
    instructions: [{ programIdIndex: 4, accounts: [1, 3, 2, 0], data: getBase58Decoder().decode(new Uint8Array([12, 1, 0, 0, 0, 0, 0, 0, 0, 0])) }],
  } }, meta: { err: null as unknown, logMessages: [`Program ${AVEO_HOOK_PROGRAM_ID} invoke [2]`, `Program ${AVEO_HOOK_PROGRAM_ID} success`],
    loadedAddresses: { writable: [] as string[], readonly: [] as string[] },
    innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 5, accounts: [1, 3, 2, 0] }] }],
    preTokenBalances: [balance(1, receipt.source, '49'), balance(2, receipt.destination, '911')],
    postTokenBalances: [balance(1, receipt.source, '48'), balance(2, receipt.destination, '912')] } }
  return { claim, receipt, sourceAccount, destinationAccount, transaction }
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('independent read-only receipt recovery', () => {
  it('verifies mocked historical ledger changes without keys, current balances or sending', () => {
    const f = fixture()
    expect(verifyRecordedTransfer(f.transaction, f.receipt, f.sourceAccount, f.destinationAccount, 0))
      .toMatchObject({ status: 'PASS', slot: 959, before: ['49', '911'], after: ['48', '912'], signingCalls: 0, submissionCalls: 0 })
  })
  it.each(['signature', 'mint', 'source', 'destination', 'amount', 'scope', 'submissions', 'before', 'secretKey'])(
    'rejects malformed receipt %s', (field) => {
      const f = fixture()
      expect(() => parseRecoveryReceipt({ ...f.claim, [field]: 'invalid' })).toThrow()
    })
  it.each(['01', '-1', '18446744073709551616', '1e2'])('rejects non-u64 balance %s', (amount) => {
    expect(() => parseRecoveryReceipt({ ...fixture().claim, before: [amount, '911'] })).toThrow()
  })
  it.each(['signature', 'slot', 'error', 'owner', 'mint', 'amount', 'authority', 'decimals', 'delta', 'missing', 'duplicate', 'hook', 'extra'])('rejects inconsistent ledger %s', (kind) => {
    const f = fixture()
    const ix = f.transaction.transaction.message.instructions[0]!
    if (kind === 'signature') f.transaction.transaction.signatures[0] = '2'.repeat(88)
    if (kind === 'slot') f.transaction.slot = 0
    if (kind === 'error') f.transaction.meta.err = { InstructionError: [1, 'custom'] }
    if (kind === 'owner') f.transaction.meta.preTokenBalances[0]!.owner = address(7)
    if (kind === 'mint') f.transaction.transaction.message.accountKeys[3] = address(7)
    if (kind === 'amount') ix.data = getBase58Decoder().decode(new Uint8Array([12, 2, 0, 0, 0, 0, 0, 0, 0, 0]))
    if (kind === 'authority') ix.accounts[3] = 3
    if (kind === 'decimals') ix.data = getBase58Decoder().decode(new Uint8Array([12, 1, 0, 0, 0, 0, 0, 0, 0, 1]))
    if (kind === 'delta') f.transaction.meta.postTokenBalances[0]!.uiTokenAmount.amount = '47'
    if (kind === 'missing') f.transaction.meta.postTokenBalances.pop()
    if (kind === 'duplicate') f.transaction.meta.preTokenBalances.push(f.transaction.meta.preTokenBalances[0]!)
    if (kind === 'hook') f.transaction.meta.logMessages.shift()
    if (kind === 'extra') f.transaction.transaction.message.instructions.push(f.transaction.transaction.message.instructions[0]!)
    expect(() => verifyRecordedTransfer(f.transaction, f.receipt, f.sourceAccount, f.destinationAccount, 0)).toThrow()
  })
  it('resolves v0 loaded addresses in writable then readonly order', () => {
    const f = fixture()
    f.transaction.transaction.message.accountKeys = [f.receipt.source]
    f.transaction.meta.loadedAddresses.writable = [f.sourceAccount, f.destinationAccount]
    f.transaction.meta.loadedAddresses.readonly = [f.receipt.mint, TOKEN_2022_PROGRAM_ID, AVEO_HOOK_PROGRAM_ID]
    expect(verifyRecordedTransfer(f.transaction, f.receipt, f.sourceAccount, f.destinationAccount, 0).status).toBe('PASS')
  })
  it('rejects a hook invocation associated with another instruction', () => {
    const f = fixture()
    f.transaction.meta.innerInstructions[0]!.index = 1
    expect(() => verifyRecordedTransfer(f.transaction, f.receipt, f.sourceAccount, f.destinationAccount, 0)).toThrow()
  })
  it('rejects forged historical totals even if the ledger transfer itself is valid', () => {
    const f = fixture()
    f.receipt.before[0] = '500'
    expect(() => verifyRecordedTransfer(f.transaction, f.receipt, f.sourceAccount, f.destinationAccount, 0)).toThrow()
  })
  it('does not accept missing or pruned transactions', () => {
    const f = fixture()
    expect(() => verifyRecordedTransfer(null, f.receipt, f.sourceAccount, f.destinationAccount, 0)).toThrow()
  })
  it('pins genesis before transaction reads and requires matching confirmed status', async () => {
    const f = fixture()
    const genesis = '4nfcdrcw57kgy95FkeDLZ5aVcjMThnMpW1acN1gsmZyF'
    const read = vi.fn<typeof recoveryRead>().mockResolvedValueOnce(genesis).mockResolvedValueOnce(f.transaction)
      .mockResolvedValueOnce({ value: [{ slot: 959, err: null, confirmationStatus: 'finalized' }] })
    await expect(readPinnedTransaction('http://127.0.0.1:18899', genesis, signature, read)).resolves.toEqual({ genesis, transaction: f.transaction })
    expect(read.mock.calls.map((call) => call[1])).toEqual(['getGenesisHash', 'getTransaction', 'getSignatureStatuses'])
  })
  it('never reads a transaction after a genesis mismatch', async () => {
    const read = vi.fn<typeof recoveryRead>().mockResolvedValue('11111111111111111111111111111111')
    await expect(readPinnedTransaction('http://127.0.0.1:18899', '4nfcdrcw57kgy95FkeDLZ5aVcjMThnMpW1acN1gsmZyF', signature, read)).rejects.toThrow()
    expect(read).toHaveBeenCalledOnce()
  })
  it.each(['processed', 'wrong-slot', 'failed', 'missing'])('does not verify status %s', async (kind) => {
    const f = fixture()
    const genesis = '4nfcdrcw57kgy95FkeDLZ5aVcjMThnMpW1acN1gsmZyF'
    const status = { slot: kind === 'wrong-slot' ? 960 : 959, err: kind === 'failed' ? 'failure' : null,
      confirmationStatus: kind === 'processed' ? 'processed' : 'confirmed' }
    const read = vi.fn<typeof recoveryRead>().mockResolvedValueOnce(genesis).mockResolvedValueOnce(f.transaction)
      .mockResolvedValueOnce({ value: [kind === 'missing' ? null : status] })
    await expect(readPinnedTransaction('http://127.0.0.1:18899', genesis, signature, read)).rejects.toThrow()
  })
  it('allows only bounded loopback reads and rejects redirects', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: 'genesis' }) }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await recoveryRead('http://127.0.0.1:18899', 'getGenesisHash', [])).toBe('genesis')
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:18899', expect.objectContaining({
      redirect: 'error', signal: expect.any(AbortSignal), method: 'POST',
    }))
    await expect(recoveryRead('https://api.devnet.solana.com', 'getGenesisHash', [])).rejects.toThrow()
    await expect(recoveryRead('http://127.0.0.1:18899', 'sendTransaction' as 'getTransaction', [])).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledOnce()
  })
  it('reads bounded regular public files, rejects symlinks, and preserves the file', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'aveo-resume-test-'))
    try {
      const file = path.join(directory, 'local-recovery-00000000-0000-0000-0000-000000000000.json')
      writeFileSync(file, JSON.stringify(fixture().claim))
      expect(readPublicReceiptFile(file)).toEqual(fixture().claim)
      const link = path.join(directory, 'local-recovery-11111111-1111-1111-1111-111111111111.json')
      symlinkSync(file, link)
      expect(() => readPublicReceiptFile(link)).toThrow()
      expect(() => readPublicReceiptFile(path.join(directory, 'wallets.json'))).toThrow()
      writeFileSync(file, ' '.repeat(65_537))
      expect(() => readPublicReceiptFile(file)).toThrow()
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
