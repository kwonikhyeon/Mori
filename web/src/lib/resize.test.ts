import { describe, expect, it } from 'vitest'
import { ASIDE, clampWidth, DOCK_MIN, keyWidth, layout, MAIN_MIN, SIDEBAR } from './resize'

describe('clampWidth', () => {
  it('keeps a pane inside its limits and whole', () => {
    expect(clampWidth(SIDEBAR, 100)).toBe(280)
    expect(clampWidth(SIDEBAR, 900)).toBe(560)
    expect(clampWidth(SIDEBAR, 401.6)).toBe(402)
    expect(clampWidth(ASIDE, 250)).toBe(300)
    expect(clampWidth(ASIDE, 700)).toBe(640)
  })

  it('takes the default for what is not a width', () => {
    expect(clampWidth(SIDEBAR, Number.NaN)).toBe(380)
    expect(clampWidth(ASIDE, 'wide' as unknown as number)).toBe(360)
    expect(clampWidth(SIDEBAR, null as unknown as number)).toBe(380)
  })
})

describe('layout', () => {
  it('draws the saved widths when there is room', () => {
    expect(layout(1600, 400, 380)).toEqual({ sidebar: 400, aside: 380, docked: true, sidebarMax: 560, asideMax: 640 })
  })

  it('docks the aside only from 1180 px', () => {
    expect(DOCK_MIN).toBe(1180)
    expect(layout(1179, 380, 360).docked).toBe(false)
    expect(layout(1180, 380, 360).docked).toBe(true)
  })

  it('keeps the main area at 420 px, the sidebar giving way first', () => {
    // 1180 - 48 (padding and gap) - 16 (aside gap) - 360 - 420 = 336
    const l = layout(1180, 380, 360)
    expect(l.sidebar).toBe(336)
    expect(l.aside).toBe(360)
    expect(1180 - 48 - l.sidebar - 16 - l.aside).toBeGreaterThanOrEqual(MAIN_MIN)
  })

  it('narrows the aside once the sidebar is at its least', () => {
    const l = layout(1180, 380, 640)
    expect(l.sidebar).toBe(280)
    expect(l.aside).toBe(1180 - 48 - 16 - 280 - 420)
  })

  it('lets neither pane below its least', () => {
    const l = layout(800, 560, 640)
    expect(l.sidebar).toBe(800 - 48 - 420)
    expect(layout(700, 560, null).sidebar).toBe(280)
  })

  it('lays the aside over the main area when narrow', () => {
    const l = layout(1000, 380, 600)
    expect(l.docked).toBe(false)
    expect(l.sidebar).toBe(380) // the aside takes no room from it
    expect(l.aside).toBe(1000 - 48 - 380) // no wider than the main area
  })

  it('gives the aside nothing when it is closed', () => {
    expect(layout(1600, 380, null)).toEqual({ sidebar: 380, aside: 0, docked: true, sidebarMax: 560, asideMax: 0 })
  })

  it('says how far each pane may grow now', () => {
    const l = layout(1300, 380, 360)
    expect(l.sidebarMax).toBe(1300 - 48 - 16 - 360 - 420)
    expect(l.asideMax).toBe(1300 - 48 - 16 - 380 - 420)
  })
})

describe('keyWidth', () => {
  const lim = { min: 280, max: 560 }
  it('steps 16 px, 64 with Shift, towards the arrow', () => {
    expect(keyWidth(400, lim, 1, { key: 'ArrowRight', shiftKey: false })).toBe(416)
    expect(keyWidth(400, lim, 1, { key: 'ArrowLeft', shiftKey: true })).toBe(336)
  })

  it('grows a pane on the right with the left arrow', () => {
    expect(keyWidth(400, lim, -1, { key: 'ArrowLeft', shiftKey: false })).toBe(416)
    expect(keyWidth(400, lim, -1, { key: 'ArrowRight', shiftKey: false })).toBe(384)
  })

  it('goes to the ends with Home and End and stays inside', () => {
    expect(keyWidth(400, lim, 1, { key: 'Home', shiftKey: false })).toBe(280)
    expect(keyWidth(400, lim, 1, { key: 'End', shiftKey: false })).toBe(560)
    expect(keyWidth(552, lim, 1, { key: 'ArrowRight', shiftKey: true })).toBe(560)
  })

  it('leaves other keys alone', () => {
    expect(keyWidth(400, lim, 1, { key: 'ArrowUp', shiftKey: false })).toBeNull()
    expect(keyWidth(400, lim, 1, { key: 'a', shiftKey: false })).toBeNull()
  })
})
