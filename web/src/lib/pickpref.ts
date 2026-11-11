// Whether this device reads Claude Code's windows (pickers design §6.9). On
// unless a person turned it off here; off, they pick in the terminal as
// before. It is the way out when the reading goes wrong, so it is kept per
// device and never shared.

import { signal } from '@preact/signals'
import { load, save } from './storage'

const KEY = 'mori.pick'

const read = () => load<unknown>(KEY, true) !== false

/** On unless this device turned it off. */
export const pickOn = signal(read())

export function setPickOn(on: boolean): void {
  pickOn.value = on
  save(KEY, on)
}

/** Reads this device's choice again, for tests. */
export function resetPickPref(): void {
  pickOn.value = read()
}
