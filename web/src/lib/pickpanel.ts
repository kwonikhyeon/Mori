// What the panel of a Claude Code window shows from one look to the next
// (pickers design §6.5). A window shows at once. While the terminal redraws,
// a look can find neither the window nor the input box: the panel stays a
// moment, its buttons off, and goes after SETTLE_MS. A window lost soon after
// it showed, or after the panel's own resize, is likely the panel's doing,
// as the panel cut the terminal's rows: it is held, and shows again only
// after the input box has shown. A terminal the panel cut may redraw the
// window without its title, or the first lines of it: the window is the
// same (alike), and the panel keeps the title it shows.

import { alike, type Look, type Seen } from './pick'

export interface Panel {
  seen: Seen | null
  /** The window went a moment ago: the panel stays, its buttons off. */
  stale: boolean
  /** When the window showed, or when the panel last resized the terminal. */
  since: number
  /** When the window went; null while it shows. */
  lost: number | null
  /** A window kept out until the input box shows. */
  held: Seen | null
}

export const NO_PANEL: Panel = { seen: null, stale: false, since: 0, lost: null, held: null }

/** How long a window may be gone before the panel goes. */
export const SETTLE_MS = 1000

/** The least height of the panel's list, in px: under it, the list is left out. */
export const MIN_CAP = 120

/** The panel after a look at a time. */
export function next(p: Panel, l: Look, at: number): Panel {
  const seen = l.seen
  if (seen) {
    if (p.held && alike(seen, p.held)) return p
    if (p.seen && alike(seen, p.seen)) {
      // a redraw that cuts the title keeps the one the panel shows
      const kept = seen.title !== p.seen.title && p.seen.title.endsWith(seen.title) ? { ...seen, title: p.seen.title } : seen
      // the same window: a look that finds it as it was changes nothing, so the view need not redraw
      return !p.stale && kept.sig === p.seen.sig ? p : { ...p, seen: kept, stale: false, lost: null }
    }
    return { seen, stale: false, since: at, lost: null, held: null }
  }
  if (!p.seen) return l.box ? (p.held === null ? p : { ...p, held: null }) : p
  if (l.box) return NO_PANEL
  const lost = p.lost ?? at
  if (at - lost < SETTLE_MS) return p.stale && p.lost === lost ? p : { ...p, stale: true, lost }
  return { ...NO_PANEL, held: lost - p.since < SETTLE_MS ? p.seen : null }
}

/** The panel resized the terminal at a time: what goes next may be its doing. */
export function restart(p: Panel, at: number): Panel {
  return p.seen ? { ...p, since: at } : p
}

/**
 * The height of the panel's list: at most half the view, and enough left for
 * the terminal to keep the window's rows and the two of the box beside the
 * rest of the panel, its title and keys (chrome). Under MIN_CAP the list is
 * left out (0): the window stays whole on the terminal, and the panel shows
 * its title and keys alone (design §6.4). MIN_CAP while nothing was measured.
 */
export function capOf(total: number, cellH: number, rows: number, viewH: number, chrome: number): number {
  if (total <= 0) return MIN_CAP
  const room = Math.min(viewH / 2, total - cellH * (rows + 2) - chrome)
  return room < MIN_CAP ? 0 : Math.round(room)
}
