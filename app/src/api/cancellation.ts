/** Never expose the caller's abort reason or transport details. */
export function throwIfReadAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('Read cancelled.', 'AbortError')
}

/** Bound a read even when its transport ignores cancellation. */
export async function withReadAbort<T>(signal: AbortSignal | undefined, read: () => Promise<T>): Promise<T> {
  throwIfReadAborted(signal)
  if (!signal) return read()

  let onAbort!: () => void
  try {
    return await new Promise<T>((resolve, reject) => {
      onAbort = () => reject(new DOMException('Read cancelled.', 'AbortError'))
      signal.addEventListener('abort', onAbort, { once: true })
      // Both handlers stay attached so a late transport rejection is handled.
      try {
        read().then(resolve, reject)
      } catch (error) {
        reject(error)
      }
    })
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
