import { useQuery, useQueryClient } from '@tanstack/react-query'
import { NavLink, Outlet, useLocation } from 'react-router'
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
  { to: '/recibos', label: 'nav.receipts' },
  { to: '/rede', label: 'nav.status' },
]

const HERO: Record<string, { title: MessageKey; description: MessageKey }> = {
  '/carteiras': { title: 'ux.assetsTitle', description: 'ux.assetsDescription' },
  '/transferencia': { title: 'ux.transferTitle', description: 'ux.transferDescription' },
  '/incidentes': { title: 'ux.incidentsTitle', description: 'ux.incidentsDescription' },
  '/recibos': { title: 'ux.receiptsTitle', description: 'ux.receiptsDescription' },
  '/rede': { title: 'ux.statusTitle', description: 'ux.statusDescription' },
}

function LanguageSwitch() {
  const { language, setLanguage, t } = useI18n()
  return (
    <div className="lang" role="group" aria-label={t('app.language')}>
      {(['pt', 'en'] as const).map((lang) => (
        <button key={lang} type="button" aria-pressed={language === lang} lang={lang} className={language === lang ? 'active' : ''} onClick={() => setLanguage(lang)}>
          {lang.toUpperCase()}
        </button>
      ))}
    </div>
  )
}

export function Layout() {
  const { t, locale } = useI18n()
  const desk = useDesk()
  const { pathname } = useLocation()
  const hero = HERO[pathname.replace(/\/$/, '')] ?? HERO['/carteiras']
  const queryClient = useQueryClient()
  const status = useQuery({
    queryKey: ['network-status'],
    queryFn: () => readNetworkStatus(desk.rpcReader),
    refetchInterval: 15_000,
  })
  // A failed refresh makes cached data unsuitable as a live network signal.
  const networkState = status.isError ? 'blocked' : status.isFetching || !status.data ? 'pending' : 'current'

  return (
    <div className="app">
      <button type="button" className="skip-link" onClick={() => document.getElementById('desk-content')?.focus()}>
        {t('ux.skipToContent')}
      </button>
      <header className="topbar">
        <div className="brand">
          <img src="/favicon.svg" alt="" width={30} height={30} />
          <div>
            <strong>{t('app.name')}</strong>
            <span className="muted small">{t('app.tagline')}</span>
          </div>
        </div>
        <div className="topbar-right">
          <span className="pill network-status" role="status" data-status={networkState}>
            {desk.env.VITE_CLUSTER}
            {' · '}
            {networkState === 'blocked' ? t('ux.networkUnavailable') : networkState === 'pending' ? t('ux.networkLoading') : `slot ${formatSlot(locale, status.data!.slot)}`}
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

      <nav className="tabs" aria-label={t('ux.navigation')}>
        {NAV.map((item) => (
          <NavLink key={item.to} to={item.to} className={({ isActive }) => (isActive ? 'active' : '')}>
            {t(item.label)}
          </NavLink>
        ))}
      </nav>

      <main id="desk-content" tabIndex={-1}>
        <div className="page-intro">
          <p className="section-kicker">{t('ux.eyebrow')}</p>
          <h1>{t(hero.title)}</h1>
          <p className="page-description">{t(hero.description)}</p>
        </div>
        <Outlet />
      </main>
    </div>
  )
}
