// How many terminals wait for a person (spec §3 #122): the page title. The
// app icon, in the taskbar or on the home screen, shows no number, and a
// number an earlier Mori put there is cleared (spec §3 #240).

/** "(3) Mori"; nothing to do is no number at all. */
export function showNeeds(n: number): void {
  document.title = n > 0 ? `(${n}) Mori` : 'Mori'
  const nav = navigator as Navigator & { clearAppBadge?: () => Promise<void> }
  nav.clearAppBadge?.().catch(() => {}) // no badge, or no permission to clear it
}
