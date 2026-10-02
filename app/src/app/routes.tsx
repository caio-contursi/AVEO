import type { RouteObject } from 'react-router'
import { RequireDeployment } from './RequireDeployment'
import { AssetsPage } from '../features/assets/AssetsPage'
import { IncidentsPage } from '../features/incidents/IncidentsPage'
import { StatusPage } from '../features/status/StatusPage'
import { TransferPage } from '../features/transfer/TransferPage'

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
  {
    path: 'transferencia',
    element: (
      <RequireDeployment>
        <TransferPage />
      </RequireDeployment>
    ),
  },
  {
    path: 'incidentes',
    element: (
      <RequireDeployment>
        <IncidentsPage />
      </RequireDeployment>
    ),
  },
  { path: 'rede', element: <StatusPage /> },
]
