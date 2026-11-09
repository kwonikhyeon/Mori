// The window's width decides the layout (spec §3 #120): below 768 px the
// phone screens with a bottom tab bar, from there the PC panes.
import { computed, signal } from '@preact/signals'

export const PHONE_MAX = 767

export const viewportWidth = signal(typeof window === 'undefined' ? 1280 : window.innerWidth)
export const isPhone = computed(() => viewportWidth.value <= PHONE_MAX)

export function trackWidth(): () => void {
  const update = () => {
    viewportWidth.value = window.innerWidth
  }
  update()
  window.addEventListener('resize', update)
  return () => window.removeEventListener('resize', update)
}
