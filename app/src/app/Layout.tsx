import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router'
import { readNetworkStatus } from '../api/inventory'
import { formatSlot } from '../components/format'
import { Icon, type IconName } from '../components/icons'
import { useI18n } from '../i18n/context'
import type { MessageKey } from '../i18n/messages'
import { WalletMenu } from '../wallet/WalletMenu'
import { PendingSubmission } from '../features/operations/PendingSubmission'
import { useDesk } from './desk'

const NAV: { to: string; label: MessageKey; icon: IconName }[] = [
  { to: '/demonstracao', label: 'nav.demo', icon: 'demo' },
  { to: '/carteiras', label: 'nav.assets', icon: 'assets' },
  { to: '/transferencia', label: 'nav.transfer', icon: 'transfer' },
  { to: '/incidentes', label: 'nav.incidents', icon: 'incidents' },
  { to: '/recibos', label: 'nav.receipts', icon: 'receipts' },
  { to: '/rede', label: 'nav.status', icon: 'status' },
]

const HERO: Record<string, { title: MessageKey; description: MessageKey }> = {
  '/demonstracao': { title: 'demo.title', description: 'demo.description' },
  '/carteiras': { title: 'ux.assetsTitle', description: 'ux.assetsDescription' },
  '/transferencia': { title: 'ux.transferTitle', description: 'ux.transferDescription' },
  '/incidentes': { title: 'ux.incidentsTitle', description: 'ux.incidentsDescription' },
  '/recibos': { title: 'ux.receiptsTitle', description: 'ux.receiptsDescription' },
  '/rede': { title: 'ux.statusTitle', description: 'ux.statusDescription' },
}

/** Must match the breakpoint in styles.css where the sidebar becomes an in-flow panel. */
const COMPACT_SHELL_QUERY = '(max-width: 1023px)'

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
  const route = pathname.replace(/\/$/, '')
  const hero = HERO[route] ?? HERO['/demonstracao']
  const section = NAV.find((item) => item.to === route) ?? NAV[0]
  const queryClient = useQueryClient()
  const status = useQuery({
    queryKey: ['network-status'],
    queryFn: () => readNetworkStatus(desk.rpcReader),
    refetchInterval: 15_000,
  })
  // A failed refresh makes cached data unsuitable as a live network signal.
  const networkState = status.isError ? 'blocked' : status.isFetching || !status.data ? 'pending' : 'current'
  const networkDetail = networkState === 'blocked' ? t('ux.networkUnavailable') : networkState === 'pending' ? t('ux.networkLoading') : `slot ${formatSlot(locale, status.data!.slot)}`

  // On compact screens the sidebar is an in-flow panel below the header; closed, it leaves the tab order.
  const [menuOpen, setMenuOpen] = useState(false)
  const menuButton = useRef<HTMLButtonElement>(null)
  const sidebar = useRef<HTMLElement>(null)
  // Browsers may drop focus to <body> before the breakpoint event when the sidebar hides, so remember it.
  const focusInSidebar = useRef(false)

  useEffect(() => {
    if (!menuOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setMenuOpen(false)
      menuButton.current?.focus()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [menuOpen])

  useEffect(() => {
    const compact = window.matchMedia(COMPACT_SHELL_QUERY)
    const onBreakpoint = () => {
      // Never leave focus inside, or lost from, a region that the new layout hides.
      const stranded = sidebar.current?.contains(document.activeElement) || document.activeElement === document.body
      if (compact.matches && focusInSidebar.current && stranded) menuButton.current?.focus()
      setMenuOpen(false)
    }
    compact.addEventListener('change', onBreakpoint)
    return () => compact.removeEventListener('change', onBreakpoint)
  }, [])

  // Stateless, so it can appear in the header and in the compact panel; CSS shows exactly one.
  const refresh = (
    <button type="button" className="ghost refresh" onClick={() => void queryClient.invalidateQueries()}>
      <Icon name="refresh" size={16} />
      {t('app.refresh')}
    </button>
  )

  const focusContent = () => document.getElementById('desk-content')?.focus()
  const closeMenuAfterNavigation = () => {
    if (!menuOpen) return
    setMenuOpen(false)
    focusContent()
  }

  return (
    <div className="shell" data-menu={menuOpen ? 'open' : 'closed'}>
      <button type="button" className="skip-link" onClick={focusContent}>
        {t('ux.skipToContent')}
      </button>

      <div className="banner" role="note">
        <Icon name="flask" size={16} />
        <span className="banner-text">
          <strong>{t('app.syntheticBanner')}</strong>
          {desk.env.VITE_CLUSTER === 'localnet' && <span>{t('app.localnetNote')}</span>}
        </span>
      </div>

      <header className="topbar">
        <button
          ref={menuButton}
          type="button"
          className="ghost icon-button menu-toggle"
          aria-expanded={menuOpen}
          aria-controls="desk-sidebar"
          onClick={() => setMenuOpen((open) => !open)}
        >
          <Icon name={menuOpen ? 'close' : 'menu'} />
          <span className="sr-only">{t('ux.menu')}</span>
        </button>
        <p className="topbar-title">
          <img src="/favicon.svg" alt="" width={24} height={24} />
          <Icon name={section.icon} size={16} />
          <span>{t(section.label)}</span>
        </p>
        <div className="topbar-actions">
          <span className="pill network-status" role="status" data-status={networkState} aria-live="off">
            <span className="network-cluster">{desk.env.VITE_CLUSTER}</span>
            <span className="network-detail">{' · '}{networkDetail}</span>
          </span>
          {refresh}
          <WalletMenu />
        </div>
      </header>

      <aside
        id="desk-sidebar"
        ref={sidebar}
        className="sidebar"
        onFocus={() => { focusInSidebar.current = true }}
        onBlur={(event) => {
          if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) focusInSidebar.current = false
        }}
      >
        <div className="brand">
          <img src="/favicon.svg" alt="" width={28} height={28} />
          <div>
            <strong>{t('app.name')}</strong>
            <span className="brand-tagline">{t('ux.eyebrow')}</span>
          </div>
        </div>
        <nav className="side-nav" aria-label={t('ux.navigation')}>
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} className={({ isActive }) => (isActive ? 'active' : '')} onClick={closeMenuAfterNavigation}>
              <Icon name={item.icon} />
              <span>{t(item.label)}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <LanguageSwitch />
          {refresh}
        </div>
      </aside>

      <main id="desk-content" tabIndex={-1}>
        <div className="page-intro">
          <h1>{t(hero.title)}</h1>
          <p className="page-description">{t(hero.description)}</p>
        </div>
        <PendingSubmission />
        <Outlet />
      </main>
    </div>
  )
}
