import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => (typeof current === 'bigint' ? { $bigint: current.toString() } : current))
}

function deserialize<T>(text: string): T {
  return JSON.parse(text, (_key, current: unknown) => {
    if (
      current &&
      typeof current === 'object' &&
      Object.keys(current).length === 1 &&
      typeof (current as { $bigint?: unknown }).$bigint === 'string'
    ) {
      return BigInt((current as { $bigint: string }).$bigint)
    }
    return current
  }) as T
}

/**
 * Local incident history for `scan:once`. Not an authorization source:
 * the hook still decides every transfer.
 */
export class IncidentDatabase {
  private readonly db: DatabaseSync

  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec(`CREATE TABLE IF NOT EXISTS incident_store (
      scope TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`)
  }

  load<T>(scope: string): T | undefined {
    const row = this.db.prepare('SELECT payload FROM incident_store WHERE scope = ?').get(scope) as { payload: string } | undefined
    return row ? deserialize<T>(row.payload) : undefined
  }

  save(scope: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO incident_store (scope, payload, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(scope) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
      )
      .run(scope, serialize(value), new Date().toISOString())
  }

  close(): void {
    this.db.close()
  }
}

export function openIncidentDatabase(file: string): IncidentDatabase {
  return new IncidentDatabase(file)
}
