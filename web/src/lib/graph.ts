import type { LogCommit } from './types'

// How the commit graph is drawn, one SVG per row (spec §3 #128, §7.1). The
// server lays out the lanes (#106); this only turns its lines into paths, and
// every row of one graph uses the same Geom, so the lines meet between rows.

/** Room left of the first lane and right of the last. */
export const MARGIN = 4
/** The lane colours, --lane-0 … --lane-4, which the server's colour numbers cycle through. */
export const COLORS = 5
/** What a lane narrows to at least when there are many of them. */
export const LANE_MIN = 6
/** Lanes narrow while the graph would take more of a row than this. */
export const GRAPH_SHARE = 0.4
/** The most of a row the graph takes: lanes past it are cut off, which only a graph too wide even at LANE_MIN meets. */
export const GRAPH_MAX = 0.6

/** A layout's full lane width, row height and dot. */
export interface Size {
  lane: number
  h: number
  r: number
  ring: number
}

export const PC: Size = { lane: 16, h: 44, r: 4, ring: 7 }
export const PHONE: Size = { lane: 14, h: 56, r: 5, ring: 9 }

/** What every row of one graph is drawn with. */
export interface Geom {
  w: number
  h: number
  r: number
  ring: number
}

/** A line within a row from (x1, y1) to (x2, y2), in the colour the server gave it. */
export interface Seg {
  x1: number
  y1: number
  x2: number
  y2: number
  color: number
}

/** The lane width for a graph of `lanes` in a row `rowWidth` wide, or the full one before the row is measured. */
export function laneWidth(lanes: number, rowWidth: number, base: number): number {
  const room = rowWidth * GRAPH_SHARE - 2 * MARGIN
  if (rowWidth <= 0 || lanes * base <= room) return base
  return Math.max(LANE_MIN, Math.min(base, Math.floor(room / lanes)))
}

export function geom(size: Size, lanes: number, rowWidth: number): Geom {
  const w = laneWidth(lanes, rowWidth, size.lane)
  if (w === size.lane) return { w, h: size.h, r: size.r, ring: size.ring }
  const k = w / size.lane
  const r = Math.max(2, round(size.r * k))
  return { w, h: size.h, r, ring: Math.max(round(r * 1.5), round(size.ring * k)) }
}

export const laneX = (lane: number, w: number) => MARGIN + w * lane + w / 2

export function graphWidth(lanes: number, w: number, rowWidth = 0): number {
  const full = 2 * MARGIN + lanes * w
  return rowWidth > 0 ? Math.min(full, Math.floor(rowWidth * GRAPH_MAX)) : full
}

export const tone = (color: number) => color % COLORS

/**
 * A row's lines: those going by first, then those meeting its dot, so the
 * latter lie on top. `up` comes from the top edge into the dot, `down` leaves
 * the dot for the bottom edge, and `pass` runs from edge to edge.
 */
export function rowSegs(c: LogCommit, g: Geom): Seg[] {
  const x = laneX(c.lane, g.w)
  const mid = g.h / 2
  return [
    ...c.pass.map((e) => ({ x1: laneX(e.lane, g.w), y1: 0, x2: laneX(e.lane, g.w), y2: g.h, color: e.color })),
    ...c.up.map((e) => ({ x1: laneX(e.lane, g.w), y1: 0, x2: x, y2: mid, color: e.color })),
    ...c.down.map((e) => ({ x1: x, y1: mid, x2: laneX(e.lane, g.w), y2: g.h, color: e.color })),
  ]
}

/** Straight within a lane; between lanes a curve that leaves and arrives upright, so it meets the next row's line. */
export function segPath(s: Seg): string {
  if (s.x1 === s.x2) return `M${n(s.x1)} ${n(s.y1)}V${n(s.y2)}`
  const m = n((s.y1 + s.y2) / 2)
  return `M${n(s.x1)} ${n(s.y1)}C${n(s.x1)} ${m} ${n(s.x2)} ${m} ${n(s.x2)} ${n(s.y2)}`
}

/** A row's lines as one path for each colour, those going by under the rest: a long log keeps few elements. */
export function rowPaths(c: LogCommit, g: Geom): { tone: number; d: string }[] {
  const segs = rowSegs(c, g)
  return [...byTone(segs.slice(0, c.pass.length)), ...byTone(segs.slice(c.pass.length))]
}

/** The commit HEAD is on: a detached HEAD, or the branch HEAD points to. */
export const isHead = (c: LogCommit) => c.refs.some((r) => r.kind === 'head' || (r.kind === 'branch' && r.current))

function byTone(segs: Seg[]) {
  const by = new Map<number, string>()
  for (const s of segs) by.set(tone(s.color), (by.get(tone(s.color)) ?? '') + segPath(s))
  return [...by].map(([t, d]) => ({ tone: t, d }))
}

const round = (v: number) => Math.round(v * 100) / 100
const n = (v: number) => String(round(v))
