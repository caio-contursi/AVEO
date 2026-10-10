import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useI18n } from '../i18n/context'

export function MatrixScrollRegion({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const hintId = useId()
  const regionRef = useRef<HTMLDivElement>(null)
  const [overflows, setOverflows] = useState(false)

  useLayoutEffect(() => {
    const region = regionRef.current
    if (!region) return
    let active = true
    const measure = () => {
      if (active) setOverflows(region.scrollWidth > region.clientWidth)
    }
    measure()
    // The table can grow independently of its viewport (data, locale or fonts).
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(region)
    const table = region.querySelector('table')
    if (table) observer?.observe(table)
    window.addEventListener('resize', measure)
    document.fonts?.addEventListener('loadingdone', measure)
    void document.fonts?.ready.then(measure)
    return () => {
      active = false
      observer?.disconnect()
      window.removeEventListener('resize', measure)
      document.fonts?.removeEventListener('loadingdone', measure)
    }
  }, [children])

  return (
    <>
      {overflows && <p id={hintId} className="matrix-scroll-hint">{t('assets.matrixScrollHint')}</p>}
      <div
        ref={regionRef}
        className="table-wrap matrix-scroll-region"
        role="region"
        aria-label={t('assets.matrixScrollRegion')}
        aria-describedby={overflows ? hintId : undefined}
        tabIndex={overflows ? 0 : undefined}
      >
        {children}
      </div>
    </>
  )
}
