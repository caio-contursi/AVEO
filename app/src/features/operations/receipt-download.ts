import { exportPublicReceiptHistory } from './receipt-export'

export type ReceiptHistoryDownloadResult =
  | { status: 'downloadRequested' }
  | { status: 'downloadFailed'; text: string }
  | { status: 'invalidExport' }

/** User-requested local file only; a click cannot prove the browser saved it. */
export function downloadPublicReceiptHistory(
  receipts: unknown, isCurrent: () => boolean = () => true,
): ReceiptHistoryDownloadResult | undefined {
  const current = () => {
    try { return isCurrent() } catch { return false }
  }
  if (!current()) return undefined
  const text = exportPublicReceiptHistory(receipts)
  if (!current()) return undefined
  if (text === undefined) return { status: 'invalidExport' }

  let link: HTMLAnchorElement | undefined
  let objectUrl: string | undefined
  let requested = false
  try {
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' })
    objectUrl = URL.createObjectURL(blob)
    link = document.createElement('a')
    link.href = objectUrl
    link.download = 'aveo-public-submission-history.json'
    link.hidden = true
    document.body.appendChild(link)
    if (!current()) return undefined
    link.click()
    requested = true
    return current() ? { status: 'downloadRequested' } : undefined
  } catch {
    return current() ? { status: 'downloadFailed', text } : undefined
  } finally {
    try { link?.remove() } catch { /* Cleanup failure must not trigger another request. */ }
    if (objectUrl !== undefined) {
      const url = objectUrl
      const revoke = () => {
        try { URL.revokeObjectURL(url) } catch { /* Browser cleanup is best effort. */ }
      }
      // Let the browser consume the object URL before releasing a requested file.
      if (requested) {
        try { setTimeout(revoke, 0) } catch { revoke() }
      } else revoke()
    }
  }
}
