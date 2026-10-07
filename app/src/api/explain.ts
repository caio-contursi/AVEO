// Completa um motivo lido dos logs da transação com os parâmetros do diagnóstico do mesmo plano.
// O hook devolve só o código (ex.: 6005); o diagnóstico já sabe qual ativo, verificador e lado.
import type { Side } from '@aveo/contracts'
import type { DeskSnapshot, DiagnosticReason } from './diagnostics'

export interface PlanContext {
  request: { kind: string }
  diagnostics: { source: DeskSnapshot; destination: DeskSnapshot }
}

const hasParams = (reason: DiagnosticReason) => !!reason.params && Object.keys(reason.params).length > 0

export function withDiagnosticParams<T extends DiagnosticReason | undefined>(failure: T, plan: PlanContext): T {
  if (!failure || hasParams(failure)) return failure
  // Numa transferência o hook confere a origem antes do destino; nas outras ações há uma parte só.
  const parties: { snapshot: DeskSnapshot; side?: Side }[] =
    plan.request.kind === 'transfer'
      ? [
          { snapshot: plan.diagnostics.source, side: 'source' },
          { snapshot: plan.diagnostics.destination, side: 'destination' },
        ]
      : [{ snapshot: plan.diagnostics.source }]
  for (const { snapshot, side } of parties) {
    const match = snapshot.reasons.find((r) => !r.hint && r.code === failure.code && hasParams(r))
    if (match) return { ...failure, params: match.params, side: failure.side ?? match.side ?? side }
  }
  return failure
}
