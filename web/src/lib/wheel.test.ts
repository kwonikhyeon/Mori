import { describe, expect, it } from 'vitest'
import { ALONE, newPace, pace, WHEEL_SPEED, wheelRows } from './wheel'

/** Rows Claude Code 2.1.323 moves for reports at these times: 3 for one alone (over 40 ms), else 1. */
function moved(times: number[]): number {
  let last = -Infinity
  let rows = 0
  for (const t of times) {
    rows += t - last > 40 ? 3 : 1
    last = t
  }
  return rows
}

/** Feeds wheel events of px every gap ms; the times reports went and the rows the wheel was. */
function gesture(n: number, px: number, gap: number, rowH = 19.5) {
  const p = newPace()
  const times: number[] = []
  let rows = 0
  for (let i = 0; i < n; i++) {
    const t = i * gap
    const r = wheelRows(p, { deltaY: px, deltaMode: 0 }, rowH, 40)
    rows += r
    for (const s of pace(p, r, t)) {
      expect(s).toBe(Math.sign(px))
      times.push(t)
    }
  }
  return { times, rows }
}

describe('wheelRows', () => {
  it('keeps what is short of a row, slows pixels, and counts lines and pages', () => {
    const p = newPace()
    expect(wheelRows(p, { deltaY: 20, deltaMode: 0 }, 20, 40)).toBe(0)
    expect(wheelRows(p, { deltaY: 20, deltaMode: 0 }, 20, 40)).toBe(1)
    // a row for 1 / WHEEL_SPEED rows of pixels
    expect(wheelRows(p, { deltaY: 200, deltaMode: 0 }, 20, 40)).toBe(10 * WHEEL_SPEED)
    expect(wheelRows(p, { deltaY: -3, deltaMode: 1 }, 20, 40)).toBe(-3)
    expect(wheelRows(p, { deltaY: 1, deltaMode: 2 }, 20, 40)).toBe(40)
  })
})

describe('pace', () => {
  // the swipe that moved Claude Code 6 rows in two jumps (spec §3 #254): its rows, 3 at a time while slow
  it('moves a slow trackpad swipe its rows', () => {
    const { times, rows } = gesture(60, -6, 16)
    expect(Math.abs(moved(times) - Math.abs(rows))).toBeLessThanOrEqual(ALONE - 1)
  })

  // fast, a row each: reports close together
  it('moves a fast trackpad swipe its rows, a row at a time', () => {
    const { times, rows } = gesture(60, -40, 16)
    expect(Math.abs(moved(times) - Math.abs(rows))).toBeLessThanOrEqual(ALONE - 1)
    expect(times.length).toBeGreaterThan(Math.abs(rows) - ALONE)
  })

  it('moves a mouse wheel its rows, notch by notch', () => {
    const { times, rows } = gesture(10, 100, 120)
    expect(Math.abs(moved(times) - rows)).toBeLessThanOrEqual(ALONE - 1)
  })

  it('sends nothing for under 3 rows alone, and turns with the wheel', () => {
    const p = newPace()
    expect(pace(p, 2, 0)).toEqual([])
    expect(pace(p, 1, 100)).toEqual([1])
    expect(pace(p, -1, 110)).toEqual([-1])
    // back the other way, after a while: 3 wait again
    expect(pace(p, -2, 500)).toEqual([])
    expect(pace(p, -1, 510)).toEqual([-1])
  })
})
