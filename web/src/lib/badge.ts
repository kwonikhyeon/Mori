// How many terminals wait for a person (spec §3 #122): the badge of the
// tab, the page title and the home screen icon.
import { computed } from '@preact/signals'
import { now } from './clock'
import { groupQueue, needsCount } from './queue'
import { terminals } from './store'

export const needs = computed(() => needsCount(groupQueue(terminals.value.values(), now.value)))

/** "(3) Mori" and the app icon's badge; nothing to do is no number at all. */
export function showNeeds(n: number): void {
  document.title = n > 0 ? `(${n}) Mori` : 'Mori'
  const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> }
  const p = n > 0 ? nav.setAppBadge?.(n) : nav.clearAppBadge?.()
  p?.catch(() => {}) // no permission to badge: the title still says it
}
