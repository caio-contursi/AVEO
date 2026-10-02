import type { RouteObject } from 'react-router'
import { EmptyState } from '../components/ui'
import { RequireDeployment } from './RequireDeployment'
import { AssetsPage } from '../features/assets/AssetsPage'
import { StatusPage } from '../features/status/StatusPage'

/** Telas do Desk. Cada módulo entra aqui no próprio commit. */
export const routes: RouteObject[] = [
  {
    path: 'carteiras',
    element: (
      <RequireDeployment>
        <AssetsPage />
      </RequireDeployment>
    ),
  },
  { path: 'transferencia', element: <EmptyState /> },
  { path: 'incidentes', element: <EmptyState /> },
  { path: 'rede', element: <StatusPage /> },
]
