// MOCK ISOLADO: histórico de incidentes no localStorage deste navegador.
// Substitui o SQLite previsto em packages/backend-aveo, que está vazio (docs/backend-pendencias.md).
// Só guarda o que o Desk já leu da rede; nenhuma decisão de elegibilidade sai daqui.
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { useReadyDesk } from '../../app/desk'
import { EMPTY_STORE, type DeskIncident, type IncidentStoreData } from './model'

const PREFIX = 'aveo.desk.incidents.v1'

const serialize = (data: IncidentStoreData) => JSON.stringify(data, (_k, v: unknown) => (typeof v === 'bigint' ? { $bigint: v.toString() } : v))

function deserialize(text: string): IncidentStoreData {
  const parsed = JSON.parse(text, (_k, v: unknown) => {
    if (v && typeof v === 'object' && Object.keys(v).length === 1 && typeof (v as { $bigint?: unknown }).$bigint === 'string') {
      return BigInt((v as { $bigint: string }).$bigint)
    }
    return v
  }) as IncidentStoreData
  return parsed?.version === 1 && Array.isArray(parsed.incidents) ? parsed : EMPTY_STORE
}

class LocalIncidentStore {
  private data: IncidentStoreData
  private readonly listeners = new Set<() => void>()
  private readonly key: string

  constructor(key: string) {
    this.key = key
    this.data = this.load()
  }

  private load(): IncidentStoreData {
    try {
      const raw = localStorage.getItem(this.key)
      return raw ? deserialize(raw) : EMPTY_STORE
    } catch {
      return EMPTY_STORE
    }
  }

  getSnapshot = () => this.data

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  update = (fn: (data: IncidentStoreData) => IncidentStoreData) => {
    this.data = fn(this.data)
    try {
      localStorage.setItem(this.key, serialize(this.data))
    } catch {
      // sem armazenamento (aba privada, bloqueio): o histórico vale só nesta sessão
    }
    this.listeners.forEach((listener) => listener())
  }
}

const stores = new Map<string, LocalIncidentStore>()

/** Um histórico por rede, programa e geração de fixtures: refazer o ambiente local começa do zero. */
export function useIncidentStore() {
  const { ctx, deployment } = useReadyDesk()
  const key = `${PREFIX}:${ctx.cluster}:${ctx.programId}:${deployment.generatedAt}`
  const store = useMemo(() => {
    let existing = stores.get(key)
    if (!existing) {
      existing = new LocalIncidentStore(key)
      stores.set(key, existing)
    }
    return existing
  }, [key])
  const data = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const patch = useCallback(
    (id: string, fn: (incident: DeskIncident) => DeskIncident) =>
      store.update((d) => ({ ...d, incidents: d.incidents.map((i) => (i.id === id ? fn(i) : i)) })),
    [store],
  )
  return { data, update: store.update, patch }
}
