// The wheel's rows to Claude Code, 1:1 (spec §3 #254). Claude Code 2.1.323
// knows xterm.js by its version reply and counts a wheel report as 1 row when
// it comes within 40 ms of the last one, else as 3 (its wheelFlood rule).
// xterm.js sends one report a wheel event, whatever rows the event is, and
// damps a trackpad's to 0.3: a swipe of 18 rows moved Claude Code 6, in two
// jumps of 3. Here the rows a wheel or a finger moves go as reports close
// together, a row each, and a report alone goes only once 3 rows wait, as it
// moves 3.

/**
 * A row for this many rows' worth of a wheel's pixels. A PC's trackpad and
 * mouse already scroll with the system's acceleration and momentum: at 1:1
 * they ran too fast (2026-11-13). A finger on a phone stays 1:1 (touchscroll.ts).
 */
export const WHEEL_SPEED = 0.5
/** Close enough to count as 1 row: under Claude Code's 40 ms, for the way there. */
export const CLOSE_MS = 30
/** The rows a report alone moves. */
export const ALONE = 3

export interface Pace {
  /** Pixels short of a whole row. */
  px: number
  /** Rows waiting to go, down positive. */
  rows: number
  /** When the last report went. */
  last: number
}

export const newPace = (): Pace => ({ px: 0, rows: 0, last: -Infinity })

/** The whole rows a wheel event moves, down positive; what is short of a row waits. */
export function wheelRows(p: Pace, ev: { deltaY: number; deltaMode: number }, rowH: number, pageRows: number): number {
  const px = ev.deltaMode === 1 ? ev.deltaY * rowH : ev.deltaMode === 2 ? ev.deltaY * pageRows * rowH : ev.deltaY * WHEEL_SPEED
  p.px += px
  const rows = Math.trunc(p.px / rowH)
  p.px -= rows * rowH
  return rows
}

/** The reports to send for rows more, at now: each the sign of its row, down positive. */
export function pace(p: Pace, rows: number, now: number): number[] {
  p.rows += rows
  const s = Math.sign(p.rows)
  const out: number[] = []
  if (!s) return out
  if (now - p.last >= CLOSE_MS) {
    // a report alone moves 3: it waits for them
    if (Math.abs(p.rows) < ALONE) return out
    out.push(s)
    p.rows -= s * ALONE
  }
  while (Math.abs(p.rows) >= 1) {
    out.push(s)
    p.rows -= s
  }
  p.last = now
  return out
}
