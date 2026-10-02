import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Navigate, RouterProvider, createHashRouter, type RouteObject } from 'react-router'
import { Card, ErrorState } from '../components/ui'
import { envResult } from '../config/env'
import { useI18n } from '../i18n/context'
import { WalletProvider } from '../wallet/WalletProvider'
import { DeskProvider } from './DeskProvider'
import { Layout } from './Layout'
import { routes } from './routes'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 10_000 },
  },
})

const router = createHashRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <Navigate to="/carteiras" replace /> },
      ...(routes as RouteObject[]),
      { path: '*', element: <Navigate to="/carteiras" replace /> },
    ],
  },
])

function InvalidEnv({ issues }: { issues: string[] }) {
  const { t } = useI18n()
  return (
    <main className="app">
      <Card title={t('config.title')}>
        <ErrorState title={t('config.invalidEnv')}>
          <ul className="small">
            {issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </ErrorState>
      </Card>
    </main>
  )
}

export function App() {
  if (!envResult.ok) return <InvalidEnv issues={envResult.issues} />
  const env = envResult.env
  return (
    <QueryClientProvider client={queryClient}>
      <DeskProvider env={env}>
        <WalletProvider cluster={env.VITE_CLUSTER} devWalletsEnabled={env.VITE_ENABLE_DEV_WALLETS}>
          <RouterProvider router={router} />
        </WalletProvider>
      </DeskProvider>
    </QueryClientProvider>
  )
}
