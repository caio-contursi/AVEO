import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { getAddressDecoder } from '@solana/kit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeskSnapshot } from '../src/api/diagnostics'
import { applyScan, EMPTY_STORE } from '../src/features/incidents/model'
import { checkIncidentPersistence } from './persistence-check'

const mocks = vi.hoisted(() => ({ fork: vi.fn(), remove: vi.fn(), directory: '' }))
vi.mock('node:child_process', () => ({ fork: mocks.fork }))
vi.mock('node:fs', async (original) => ({
  ...await original<typeof import('node:fs')>(),
  mkdtempSync: () => mocks.directory, rmSync: mocks.remove,
}))

class FakeChild extends EventEmitter {
  pid = 777
  kill = vi.fn(() => true)
  input?: unknown
  send(input: unknown, callback: (error: Error | null) => void) { this.input = input; callback(null) }
}

const addr = (value: number) => getAddressDecoder().decode(new Uint8Array(32).fill(value))
const snapshots: DeskSnapshot[] = [addr(1), addr(2)].map((mint) => ({
  backend: 'aveo-sas-hook', mint, wallet: addr(3), verdict: 'ineligible', actions: [],
  read: { cluster: 'localnet', rpcUrl: 'http://127.0.0.1:8899', commitment: 'confirmed', slot: 100, observedAt: '2026-10-09T12:00:00.000Z' },
  reasons: [{ code: 'AttestationMissingOrClosed', message: 'AttestationMissingOrClosed' }],
  sourceAccounts: { attestation: addr(4) },
}))
const scan = applyScan(EMPTY_STORE, snapshots, 100, '2026-10-09T12:00:00.000Z')

beforeEach(() => {
  vi.clearAllMocks()
  mocks.directory = path.join(tmpdir(), 'aveo-persistence-mocked')
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs() })

describe('persistence worker failure and cleanup lifecycle', () => {
  it.each(['deadline', 'ipc-error', 'invalid-message', 'nonzero-exit'] as const)(
    'does not claim success after %s and waits for worker close before cleanup', async (failure) => {
      vi.useFakeTimers()
      const child = new FakeChild(), emit = vi.fn(), complete = vi.fn()
      mocks.fork.mockReturnValue(child)
      const pending = checkIncidentPersistence(scan, snapshots, emit, complete)
      let settled = false
      void pending.then(() => { settled = true }, () => { settled = true })
      if (failure === 'deadline') await vi.advanceTimersByTimeAsync(15_000)
      else if (failure === 'ipc-error') child.emit('error', new Error('private error'))
      else if (failure === 'invalid-message') child.emit('message', { pid: 999, private: 'secret' })
      else child.emit('close', 1)
      if (failure !== 'nonzero-exit') {
        expect(child.kill).toHaveBeenCalledWith('SIGKILL')
        expect(mocks.remove).not.toHaveBeenCalled()
        expect(settled).toBe(false)
        child.emit('close', null)
      }
      await expect(pending).rejects.toThrow('Local incident persistence check failed')
      expect(complete).not.toHaveBeenCalled()
      expect(emit).not.toHaveBeenCalled()
      expect(mocks.remove).toHaveBeenCalledExactlyOnceWith(mocks.directory, { recursive: true, force: true })
    },
  )

  it('does not inherit executable arguments or NODE_OPTIONS into a worker', async () => {
    const child = new FakeChild()
    mocks.fork.mockReturnValue(child)
    vi.stubEnv('NODE_OPTIONS', '--inspect=127.0.0.1:9229')
    const pending = checkIncidentPersistence(scan, snapshots, vi.fn(), vi.fn())
    const rejected = expect(pending).rejects.toThrow('Local incident persistence check failed')
    expect(mocks.fork.mock.calls[0]?.[1]).toEqual(['--persistence-worker'])
    const options = mocks.fork.mock.calls[0]?.[2]
    expect(options.execPath).toBe(process.execPath)
    expect(options.execArgv).toEqual(['--import', 'tsx'])
    expect(options.env.NODE_OPTIONS).toBeUndefined()
    expect(options.stdio).toEqual(['ignore', 'ignore', 'ignore', 'ipc'])
    child.emit('close', 1)
    await rejected
  })
})
