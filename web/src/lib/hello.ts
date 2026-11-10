// What GET /api/hello said of the hub (spec §7.1), and the name the page
// gives it. boot.ts asks; the scopes read it without calling boot.
import { computed, signal } from '@preact/signals'
import { host } from './store'
import type { Hello } from './types'

/** What GET /api/hello said; null when it could not be asked. */
export const hello = signal<Hello | null>(null)
/** This host's name: the overview's once it came, hello's before. */
export const hostLabel = computed(() => host.value?.name ?? hello.value?.host ?? '')
