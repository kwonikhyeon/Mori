// How many terminal cells fit in a box (spec §3 #125). xterm draws its
// scrollbar inside the box, so its width is not for cells; the server
// keeps a size between 10 and 1000 either way.

import type { Size } from './attach'

export const SCROLLBAR = 14

const MIN = 10
const MAX = 1000

const clamp = (n: number) => Math.min(Math.max(n, MIN), MAX)

/** The whole cells that fit in width × height, or null while unknown. */
export function fitSize(width: number, height: number, cell: [number, number]): Size | null {
  const [cw, ch] = cell
  const w = width - SCROLLBAR
  if (!(cw > 0) || !(ch > 0) || w <= 0 || height <= 0) return null
  return { cols: clamp(Math.floor(w / cw)), rows: clamp(Math.floor(height / ch)) }
}
