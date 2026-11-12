// How many terminal cells fit in a box (spec §3 #125). xterm draws its
// scrollbar inside the box, so its width is not for cells; the server
// keeps a size between 10 and 1000 either way.

import type { Size } from './attach'

export const SCROLLBAR = 14

const MIN = 10
/** The most cells the server keeps either way. */
export const MAX_CELLS = 1000

const clamp = (n: number) => Math.min(Math.max(n, MIN), MAX_CELLS)

/** The whole cells that fit in width × height, or null while unknown. */
export function fitSize(width: number, height: number, cell: [number, number]): Size | null {
  const [cw, ch] = cell
  const w = width - SCROLLBAR
  if (!(cw > 0) || !(ch > 0) || w <= 0 || height <= 0) return null
  return { cols: clamp(Math.floor(w / cw)), rows: clamp(Math.floor(height / ch)) }
}

/**
 * The rows to add while Claude Code's box and the lines under it lie under
 * the status band (spec §3 #228): enough that the k rows from its box down
 * start where the band's sheet does, so its output reaches the sheet, and
 * the rest of the k rows lie below the stage's edge. rows are the rows that
 * fit, room the stage's height from the first row down, sheet the sheet's.
 * Taken once as the cover comes and added to the rows that fit after, so a
 * stage a few pixels taller or shorter without the cover leaves the size as
 * it is.
 */
export function coverExtra(rows: number, room: number, cellH: number, sheet: number, k: number): number {
  if (!(cellH > 0) || k <= 0) return 0
  return clamp(Math.max(rows, Math.floor((room - sheet) / cellH) + k)) - rows
}
