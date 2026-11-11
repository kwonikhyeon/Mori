// Whether this device shows Claude Code's own input box, and what is below
// it, rather than Mori's status band over them (claude-input design §3.4).
// Off unless a person turned it on here: it is the way back to the
// terminal's own box, so it is kept per device and never shared.

import { signal } from '@preact/signals'
import { load, save } from './storage'

const KEY = 'mori.box.shown'

const read = () => load<unknown>(KEY, false) === true

/** On once this device asked to see the terminal's own input box. */
export const boxShown = signal(read())

export function setBoxShown(on: boolean): void {
  boxShown.value = on
  save(KEY, on)
}

/** Reads this device's choice again, for tests. */
export function resetBoxPref(): void {
  boxShown.value = read()
}
