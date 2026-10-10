import { inspectTransfer, prepareTransfer, verifyPreparedTransfer } from '@aveo/backend-aveo/integration'
import { DeskError, type EligibilityBackend } from '@aveo/contracts'
import { describe, expect, it, vi } from 'vitest'

describe('independent integration package entry point', () => {
  it('exposes preparation and verification without importing Desk internals', () => {
    expect(typeof inspectTransfer).toBe('function')
    expect(typeof prepareTransfer).toBe('function')
    expect(typeof verifyPreparedTransfer).toBe('function')
  })
  it('rejects an unsupported backend before calling its network operations', async () => {
    const unexpected = vi.fn().mockRejectedValue(new Error('Unexpected network operation'))
    const backend: EligibilityBackend = { id: 'aveo-sas-hook', capabilities: () => [],
      inspect: unexpected, planTransfer: unexpected, verifyOutcome: unexpected }
    const input = { cluster: 'devnet' as const, mint: 'mint', sourceOwner: 'source', destinationOwner: 'destination', amount: 1n }
    await expect(prepareTransfer(backend, input)).rejects.toBeInstanceOf(DeskError)
    await expect(prepareTransfer(backend, input)).rejects.toMatchObject({ code: 'UnsupportedCapability' })
    expect(unexpected).not.toHaveBeenCalled()
  })
})
