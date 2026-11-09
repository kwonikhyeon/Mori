// A phone puts a page to sleep and drops its sockets without a word. When
// the page is seen again or the network comes back, whatever waits out a
// backoff should try at once instead.
const fns = new Set<() => void>()

/** Runs fn on every wake; the returned function stops that. */
export function onWake(fn: () => void): () => void {
  fns.add(fn)
  return () => {
    fns.delete(fn)
  }
}

export function startWake(): () => void {
  const wake = () => {
    for (const fn of [...fns]) fn()
  }
  const seen = () => {
    if (document.visibilityState === 'visible') wake()
  }
  document.addEventListener('visibilitychange', seen)
  window.addEventListener('online', wake)
  return () => {
    document.removeEventListener('visibilitychange', seen)
    window.removeEventListener('online', wake)
  }
}
