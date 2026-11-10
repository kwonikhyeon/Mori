// The terminal's letters on this device (spec §3 #185): 13 px on a PC and
// 12 px on a phone, unless a person picks another size in 설정 or in the
// terminal's menu. The size sets how many cells fit the screen, so a change
// resizes the terminal as a window that changes size does (#125): it is a
// person's choice, never a shrink to fit.
import { signal } from '@preact/signals'
import { load, save } from './storage'

export type Layout = 'pc' | 'phone'

/** The sizes offered, in CSS pixels. */
export const FONT_SIZES = [10, 11, 12, 13, 14, 15, 16]

export const DEFAULT_FONT: Record<Layout, number> = { pc: 13, phone: 12 }

const KEY = 'mori.font'

type Picked = Partial<Record<Layout, number>>

const offered = (v: unknown): v is number => typeof v === 'number' && FONT_SIZES.includes(v)

function read(): Picked {
  const raw = load<unknown>(KEY, null)
  const out: Picked = {}
  if (raw && typeof raw === 'object') {
    for (const l of ['pc', 'phone'] as const) {
      const v = (raw as Record<string, unknown>)[l]
      if (offered(v)) out[l] = v
    }
  }
  return out
}

/** The sizes picked on this device, by layout; the default is left out. */
export const termFont = signal<Picked>(read())

/** The letters' size of the terminal in a layout. */
export function fontFor(l: Layout): number {
  return termFont.value[l] ?? DEFAULT_FONT[l]
}

export function setTermFont(l: Layout, px: number): void {
  if (!offered(px)) return
  const next = { ...termFont.peek() }
  if (px === DEFAULT_FONT[l]) delete next[l]
  else next[l] = px
  termFont.value = next
  save(KEY, next)
}

/** Reads this device's sizes again, for tests. */
export function resetTermFont(): void {
  termFont.value = read()
}
