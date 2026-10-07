// O erro do hook chega só com o código; o texto da tela precisa do ativo e do verificador.
import { describe, expect, it } from 'vitest'
import type { DeskSnapshot, DiagnosticReason } from './diagnostics'
import { withDiagnosticParams, type PlanContext } from './explain'

const snapshot = (reasons: DiagnosticReason[]) => ({ reasons }) as unknown as DeskSnapshot
const transfer = (source: DiagnosticReason[], destination: DiagnosticReason[]): PlanContext => ({
  request: { kind: 'transfer' },
  diagnostics: { source: snapshot(source), destination: snapshot(destination) },
})
const pair = { code: 'ProviderPairNotAllowed', message: 'verifier not accepted', params: { asset: 'Ativo Beta', verifier: 'Verificador B' } } as const
const fromLogs: DiagnosticReason = { code: 'ProviderPairNotAllowed', message: 'Program log: custom program error: 0x1775' }

describe('withDiagnosticParams', () => {
  it('completa o erro dos logs com o ativo e o verificador do destino', () => {
    const result = withDiagnosticParams(fromLogs, transfer([], [pair]))
    expect(result).toMatchObject({ code: 'ProviderPairNotAllowed', side: 'destination', params: { asset: 'Ativo Beta', verifier: 'Verificador B' } })
    expect(result.message).toBe(fromLogs.message)
  })

  it('prefere a origem quando as duas partes têm o mesmo motivo, como o hook', () => {
    const result = withDiagnosticParams(fromLogs, transfer([pair], [{ ...pair, params: { asset: 'Ativo Beta', verifier: 'Verificador C' } }]))
    expect(result).toMatchObject({ side: 'source', params: { verifier: 'Verificador B' } })
  })

  it('não troca parâmetros que já vieram, nem usa uma dica', () => {
    const own = { ...fromLogs, params: { asset: 'Ativo Alfa', verifier: 'Verificador A' } }
    expect(withDiagnosticParams(own, transfer([], [pair]))).toBe(own)
    expect(withDiagnosticParams(fromLogs, transfer([], [{ ...pair, hint: true }]))).toBe(fromLogs)
  })

  it('fora de uma transferência não inventa um lado', () => {
    const plan: PlanContext = { request: { kind: 'set-binding' }, diagnostics: { source: snapshot([pair]), destination: snapshot([pair]) } }
    const result = withDiagnosticParams(fromLogs, plan)
    expect(result?.side).toBeUndefined()
    expect(result?.params).toEqual(pair.params)
  })

  it('sem motivo igual no diagnóstico, devolve o erro como veio', () => {
    expect(withDiagnosticParams(fromLogs, transfer([], []))).toBe(fromLogs)
    expect(withDiagnosticParams(undefined, transfer([], [pair]))).toBeUndefined()
  })
})
