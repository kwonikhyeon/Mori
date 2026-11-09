// "N분 전" has to move on by itself (spec §3 #132): one clock for every
// screen, ticking every 30 s and at once when the page is seen again.
import { signal } from '@preact/signals'

export const now = signal(Date.now())

export function startClock(every = 30_000): () => void {
  const tick = () => {
    now.value = Date.now()
  }
  const id = setInterval(tick, every)
  const seen = () => {
    if (document.visibilityState === 'visible') tick()
  }
  document.addEventListener('visibilitychange', seen)
  return () => {
    clearInterval(id)
    document.removeEventListener('visibilitychange', seen)
  }
}
