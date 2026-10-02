import type { ReactNode } from 'react'
import { DeploymentError } from '../config/deployment'
import { Card, ErrorState, LoadingState } from '../components/ui'
import { useI18n } from '../i18n/context'
import { useDesk } from './desk'

/** Telas que precisam do manifest mostram carregamento, erro ou ajuda de configuração antes do conteúdo. */
export function RequireDeployment({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const desk = useDesk()
  if (desk.deploymentLoading) return <LoadingState />
  if (!desk.deployment) {
    const error = desk.deploymentError
    const title =
      error instanceof DeploymentError && error.kind === 'invalid' ? t('config.deploymentInvalid') : t('config.deploymentMissing')
    return (
      <Card>
        <ErrorState title={title} error={error} onRetry={desk.refetchDeployment}>
          {error instanceof DeploymentError && error.issues.length > 0 && (
            <ul className="small">
              {error.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          )}
          <p className="small">{t('config.deploymentHelp')}</p>
          <p className="small muted">
            {t('config.manifest')}: <code>{desk.env.VITE_DEPLOYMENT_URL}</code>
          </p>
        </ErrorState>
      </Card>
    )
  }
  return <>{children}</>
}
