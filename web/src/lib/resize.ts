// The PC panes people can widen (spec §3 #119, #120): the queue on the left
// and the Git aside on the right. The saved width is what the person chose;
// the drawn width is what fits this window, so a narrow window never loses
// the choice.
import { load, save } from './storage'

export interface Pane {
  key: string
  def: number
  min: number
  max: number
}

export const SIDEBAR: Pane = { key: 'mori.sidebar', def: 380, min: 280, max: 560 }
export const ASIDE: Pane = { key: 'mori.aside', def: 360, min: 300, max: 640 }

/** The terminal keeps at least this much. */
export const MAIN_MIN = 420
/** From this width the aside sits beside the main area; below it, over it. */
export const DOCK_MIN = 1180
/** The page padding and the gaps between panes; the handles sit in the gaps. */
const PAD = 16
const GAP = 16

export function clampWidth(p: Pane, w: number): number {
  if (typeof w !== 'number' || !Number.isFinite(w)) return p.def
  return Math.min(p.max, Math.max(p.min, Math.round(w)))
}

export function loadWidth(p: Pane): number {
  return clampWidth(p, load<number>(p.key, p.def))
}

export function saveWidth(p: Pane, w: number): void {
  save(p.key, clampWidth(p, w))
}

export interface Layout {
  sidebar: number
  /** 0 when the aside is closed. */
  aside: number
  /** Beside the main area rather than over it. */
  docked: boolean
  /** How wide each pane may be dragged now, the other staying as drawn. */
  sidebarMax: number
  asideMax: number
}

/**
 * The drawn widths for a window vw wide. When the main area would get less
 * than MAIN_MIN, the sidebar gives way first, then a docked aside.
 */
export function layout(vw: number, sidebar: number, aside: number | null): Layout {
  const docked = vw >= DOCK_MIN
  const fixed = 2 * PAD + GAP
  const s0 = clampWidth(SIDEBAR, sidebar)
  if (aside === null) {
    const s = Math.max(SIDEBAR.min, Math.min(s0, vw - fixed - MAIN_MIN))
    return { sidebar: s, aside: 0, docked, sidebarMax: Math.max(SIDEBAR.min, Math.min(SIDEBAR.max, vw - fixed - MAIN_MIN)), asideMax: 0 }
  }
  const a0 = clampWidth(ASIDE, aside)
  if (!docked) {
    const s = Math.max(SIDEBAR.min, Math.min(s0, vw - fixed - MAIN_MIN))
    const main = vw - fixed - s
    return {
      sidebar: s,
      aside: Math.min(a0, main),
      docked,
      sidebarMax: Math.max(SIDEBAR.min, Math.min(SIDEBAR.max, vw - fixed - MAIN_MIN)),
      asideMax: Math.min(ASIDE.max, main),
    }
  }
  const room = vw - fixed - GAP - MAIN_MIN // for both panes
  const s = Math.max(SIDEBAR.min, Math.min(s0, room - a0))
  const a = Math.max(ASIDE.min, Math.min(a0, room - s))
  return {
    sidebar: s,
    aside: a,
    docked,
    sidebarMax: Math.max(SIDEBAR.min, Math.min(SIDEBAR.max, room - a)),
    asideMax: Math.max(ASIDE.min, Math.min(ASIDE.max, room - s)),
  }
}

export interface Limits {
  min: number
  max: number
}

const STEP = 16
const BIG_STEP = 64

/**
 * The width after a key on the handle, or null for a key it does not use.
 * dir is 1 when the handle is on the pane's right edge, -1 on its left.
 */
export function keyWidth(w: number, lim: Limits, dir: 1 | -1, e: { key: string; shiftKey: boolean }): number | null {
  const step = e.shiftKey ? BIG_STEP : STEP
  let next: number
  switch (e.key) {
    case 'ArrowRight': next = w + dir * step; break
    case 'ArrowLeft': next = w - dir * step; break
    case 'Home': next = lim.min; break
    case 'End': next = lim.max; break
    default: return null
  }
  return Math.min(lim.max, Math.max(lim.min, next))
}
