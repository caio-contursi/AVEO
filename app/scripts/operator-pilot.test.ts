import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

interface TaskTemplate {
  id: string
  title: string
  status: string
  tx_signatures: unknown[]
  observation_slot: number | null
  transaction_checks: unknown[]
  fresh_reads: unknown[]
  desk: Record<string, number | boolean | null>
  manual_baseline: Record<string, number | boolean | null>
  notes: unknown[]
}
interface PilotTemplate {
  schema_version: number
  status: string
  session_id: string | null
  participant: Record<string, unknown>
  consent: Record<string, unknown>
  release: Record<string, unknown>
  prerequisites: Record<string, unknown>
  protocol: Record<string, unknown>
  scenes: TaskTemplate[]
  blind_task: TaskTemplate
  feedback: Record<string, unknown>
  validation: Record<string, unknown>
}

// Repository template integrity only: this is not a validator for executed pilot evidence.
const template: PilotTemplate = JSON.parse(readFileSync(new URL('../../docs/operator-pilot-session.example.json', import.meta.url), 'utf8'))

describe('unexecuted operator pilot template', () => {
  it('does not claim recruitment, consent or execution', () => {
    expect(template.schema_version).toBe(1)
    expect(template.status).toBe('NOT_RUN')
    expect(template.session_id).toBeNull()
    expect(Object.values(template.participant).every((value) => value === null)).toBe(true)
    expect(template.consent).toEqual({ permission: false, status: 'not_granted', accepted_at: null,
      anonymized_notes_allowed: false, public_feedback_allowed: false })
  })
  it('does not invent a public deployment, prerequisites or measurements', () => {
    expect(template.release.cluster).toBe('devnet')
    expect(Object.entries(template.release).filter(([key]) => key !== 'cluster').every(([, value]) => value === null)).toBe(true)
    expect(Object.values(template.prerequisites).every((value) => value === null)).toBe(true)
    expect(Object.values(template.protocol).every((value) => value === null)).toBe(true)
  })
  it('covers the six release scenes and an independent blind task', () => {
    expect(template.scenes.map((task) => task.id)).toEqual(['S01', 'S02', 'S03', 'S04', 'S05', 'S06'])
    expect(template.blind_task.id).toBe('U01')
    expect(template.scenes.every((task) => task.title.trim().length > 0)).toBe(true)
  })
  it.each(['S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'U01'])('keeps %s results and transaction evidence empty', (id) => {
    const task = [...template.scenes, template.blind_task].find((item) => item.id === id)!
    expect(task.status).toBe('NOT_RUN')
    expect(task.tx_signatures).toEqual([])
    expect(task.observation_slot).toBeNull()
    expect(task.transaction_checks).toEqual([])
    expect(task.fresh_reads).toEqual([])
    expect(task.notes).toEqual([])
    const fields = ['elapsed_seconds', 'actions', 'errors', 'assistance_count', 'completed']
    expect(Object.keys(task.desk)).toEqual(fields)
    expect(Object.keys(task.manual_baseline)).toEqual(fields)
    expect(Object.values(task.desk).every((value) => value === null)).toBe(true)
    expect(Object.values(task.manual_baseline).every((value) => value === null)).toBe(true)
  })
  it('contains no attributed feedback or reviewer approval', () => {
    expect(template.feedback).toEqual({ anonymized_observations: [], limitations: [], publication_permission: false })
    expect(template.validation.reviewed_at).toBeNull()
    expect(Object.entries(template.validation).filter(([key]) => key !== 'reviewed_at').every(([, value]) => value === false)).toBe(true)
  })
})
