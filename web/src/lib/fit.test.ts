import { describe, expect, it } from 'vitest'
import { coverExtra, fitSize, SCROLLBAR } from './fit'

describe('fitSize', () => {
  it('counts the whole cells that fit beside the scrollbar', () => {
    // (814 - 14) / 8 = 100 columns, 408 / 17 = 24 rows
    expect(fitSize(814, 408, [8, 17])).toEqual({ cols: 100, rows: 24 })
    expect(fitSize(814 + 7, 408 + 16, [8, 17])).toEqual({ cols: 100, rows: 24 })
    expect(SCROLLBAR).toBe(14)
  })

  it('keeps the size the server accepts', () => {
    expect(fitSize(60, 60, [8, 17])).toEqual({ cols: 10, rows: 10 })
    expect(fitSize(20_000, 40_000, [8, 17])).toEqual({ cols: 1000, rows: 1000 })
  })

  it('has no size before the cells and the box are known', () => {
    expect(fitSize(800, 400, [0, 17])).toBeNull()
    expect(fitSize(800, 400, [8, 0])).toBeNull()
    expect(fitSize(14, 400, [8, 17])).toBeNull()
    expect(fitSize(800, 0, [8, 17])).toBeNull()
  })
})

describe('coverExtra', () => {
  it('adds the rows that put the box at the foot of the sheet', () => {
    // 24 rows of 17px fit 408px; a 40px sheet leaves 21 whole rows above it, and the 7 covered go after them: 28
    expect(coverExtra(24, 408, 17, 40, 7)).toBe(4)
    // the sheet as tall as the rows covered: nothing to win
    expect(coverExtra(24, 408, 17, 7 * 17, 7)).toBe(0)
  })

  it('never takes rows away, nor goes past what the server keeps', () => {
    expect(coverExtra(24, 408, 17, 300, 2)).toBe(0)
    expect(coverExtra(990, 990 * 17, 17, 0, 20)).toBe(10)
  })

  it('adds nothing while the cell or the box is unknown', () => {
    expect(coverExtra(24, 408, 0, 40, 7)).toBe(0)
    expect(coverExtra(24, 408, 17, 40, 0)).toBe(0)
  })
})
