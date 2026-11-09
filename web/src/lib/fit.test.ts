import { describe, expect, it } from 'vitest'
import { fitSize, SCROLLBAR } from './fit'

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
