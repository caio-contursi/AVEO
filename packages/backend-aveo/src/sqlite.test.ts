import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { openIncidentDatabase } from './sqlite.ts'

test('a repeated scan reloads the same store', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aveo-incidents-'))
  const file = path.join(dir, 'incidents.sqlite')
  const first = openIncidentDatabase(file)
  first.save('local', { version: 1, incidents: [{ id: 'proof-x' }], amount: 1n })
  first.close()

  const second = openIncidentDatabase(file)
  const loaded = second.load<{ incidents: { id: string }[]; amount: bigint }>('local')
  assert.equal(loaded?.incidents.length, 1)
  assert.equal(loaded?.incidents[0]?.id, 'proof-x')
  assert.equal(loaded?.amount, 1n)
  second.save('local', loaded)
  assert.equal(second.load<{ incidents: unknown[] }>('local')?.incidents.length, 1)
  second.close()
})
