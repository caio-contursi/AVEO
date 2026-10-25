/** Inline stroke icons for the Desk shell. Decorative only: every use sits next to a visible or accessible label. */
const PATHS = {
  demo: <><circle cx="12" cy="12" r="9" /><path d="M10 8.5v7l6-3.5z" /></>,
  assets: <><rect x="3" y="6" width="18" height="14" rx="2.5" /><path d="M3 10.5h18" /><path d="M7 3.5h10" /><circle cx="16.5" cy="15" r="1" /></>,
  transfer: <><path d="M4 8h15" /><path d="m15 4 4 4-4 4" /><path d="M20 16H5" /><path d="m9 12-4 4 4 4" /></>,
  incidents: <><path d="M10.3 4.2 2.6 17.6A2 2 0 0 0 4.3 20.6h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z" /><path d="M12 9.5v4" /><path d="M12 17h.01" /></>,
  receipts: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" /><path d="M9 8h6" /><path d="M9 12h6" /></>,
  status: <><path d="M3 12h4l3-7 4 14 3-7h4" /></>,
  refresh: <><path d="M20 11.5A8 8 0 0 0 5.6 6.4L4 8" /><path d="M4 4v4h4" /><path d="M4 12.5a8 8 0 0 0 14.4 5.1L20 16" /><path d="M20 20v-4h-4" /></>,
  menu: <><path d="M4 7h16" /><path d="M4 12h16" /><path d="M4 17h16" /></>,
  close: <><path d="m6 6 12 12" /><path d="M18 6 6 18" /></>,
  flask: <><path d="M9 3h6" /><path d="M10 3v6.5L4.6 18.4A1.7 1.7 0 0 0 6.1 21h11.8a1.7 1.7 0 0 0 1.5-2.6L14 9.5V3" /><path d="M7.5 15h9" /></>,
} as const

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  )
}
