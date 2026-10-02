import { useQuery, useQueryClient } from '@tanstack/react-query'
import { NavLink, Outlet } from 'react-router'
import { readNetworkStatus } from '../api/inventory'
import { formatSlot } from '../components/format'
import { useI18n } from '../i18n/context'
import type { MessageKey } from '../i18n/messages'
import { WalletMenu } from '../wallet/WalletMenu'
import { useDesk } from './desk'

const NAV: { to: string; label: MessageKey }[] = [
  { to: '/carteiras', label: 'nav.assets' },
  { to: '/transferencia', label: 'nav.transfer' },
  { to: '/incidentes', label: 'nav.incidents' },
  { to: '/rede', label: 'nav.status' },
]

function LanguageSwitch() {
  const { language, setLanguage, t } = useI18n()
  return (
    <div className="lang" role="group" aria-label={t('app.language')}>
      {(['pt', 'en'] as const).map((lang) => (
        <button key={lang} type="button" className={language === lang ? 'active' : ''} onClick={() => setLanguage(lang)}>
          {lang.toUpperCase()}
        </button>
      ))}
    </div>
  )
}

export function Layout() {
  const { t, locale } = useI18n()
  const desk = useDesk()
  const queryClient = useQueryClient()
  const status = useQuery({
    queryKey: ['network-status'],
    queryFn: () => readNetworkStatus(desk.rpcReader),
    refetchInterval: 15_000,
  })

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img src="/favicon.svg" alt="" width={30} height={30} />
          <div>
            <strong>{t('app.name')}</strong>
            <span className="muted small">{t('app.tagline')}</span>
          </div>
        </div>
        <div className="topbar-right">
          <span className="pill" title={desk.env.VITE_RPC_URL}>
            {desk.env.VITE_CLUSTER}
            {status.data && ` · slot ${formatSlot(locale, status.data.slot)}`}
          </span>
          <button type="button" className="ghost" onClick={() => void queryClient.invalidateQueries()}>
            {t('app.refresh')}
          </button>
          <LanguageSwitch />
          <WalletMenu />
        </div>
      </header>

      <div className="banner" role="note">
        <strong>{t('app.syntheticBanner')}</strong>
        {desk.env.VITE_CLUSTER === 'localnet' && <span>{t('app.localnetNote')}</span>}
      </div>

      <nav className="tabs" aria-label="Desk">
        {NAV.map((item) => (
          <NavLink key={item.to} to={item.to} className={({ isActive }) => (isActive ? 'active' : '')}>
            {t(item.label)}
          </NavLink>
        ))}
      </nav>

      <main>
        <Outlet />
      </main>
    </div>
  )
}
