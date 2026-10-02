import type { RouteObject } from 'react-router'
import { EmptyState } from '../components/ui'

/** Telas do Desk. Cada módulo entra aqui no próprio commit. */
export const routes: RouteObject[] = [
  { path: 'carteiras', element: <EmptyState /> },
  { path: 'transferencia', element: <EmptyState /> },
  { path: 'incidentes', element: <EmptyState /> },
  { path: 'rede', element: <EmptyState /> },
]
