import { describe, expect, it } from 'vitest'
import { cursorAt, SCREENS, toShot } from '../../test/screens'
import { look, NOTHING, type Look } from './pick'
import { capOf, MIN_CAP, next, NO_PANEL, restart, SETTLE_MS, type Panel } from './pickpanel'

const at = (name: string): Look => look(toShot(SCREENS[name]))
const model = at('model')
const moved = look(toShot(cursorAt(SCREENS.model, 2)))
// redrawn in a terminal the panel cut, without its title
const cut = look(toShot(SCREENS.model.split('\n').slice(3).join('\n')))
const btw = at('btw')
const idle = at('idle') // the input box, and no window
const gone: Look = NOTHING // half drawn: neither a window nor the box

/** The panel after each look, at its time. */
function run(steps: [Look, number][], from: Panel = NO_PANEL): Panel {
  return steps.reduce((p, [l, t]) => next(p, l, t), from)
}

describe('next', () => {
  it('shows a new window at once', () => {
    const p = next(NO_PANEL, model, 500)
    expect(p.seen).toBe(model.seen)
    expect(p).toMatchObject({ stale: false, since: 500, lost: null, held: null })
  })

  it('updates the same window', () => {
    const p = run([
      [model, 500],
      [moved, 800],
    ])
    expect(p.seen).toBe(moved.seen)
    expect(p.seen!.cursor).toBe(2)
    expect(p).toMatchObject({ stale: false, since: 500, lost: null })
  })

  it('keeps the title of a window whose redraw cuts it', () => {
    const p = run([
      [model, 500],
      [cut, 800],
    ])
    expect(p.seen!.title).toBe(model.seen!.title)
    expect(p.seen!.sig).toBe(cut.seen!.sig)
    expect(p.seen!.options).toBe(cut.seen!.options)
    expect(p).toMatchObject({ stale: false, since: 500, lost: null })
    // the title back as it was: the window is the same still
    const back = next(p, model, 900)
    expect(back.seen).toBe(model.seen)
    expect(back.since).toBe(500)
  })

  it('shows another window as new', () => {
    const p = run([
      [model, 500],
      [btw, 900],
    ])
    expect(p.seen).toBe(btw.seen)
    expect(p.since).toBe(900)
  })

  it('keeps a window that went a moment ago, stale', () => {
    const p = run([
      [model, 500],
      [gone, 600],
    ])
    expect(p.seen).toBe(model.seen)
    expect(p).toMatchObject({ stale: true, lost: 600, since: 500 })
    // still gone a moment later: lost stays where it went
    expect(next(p, gone, 900)).toMatchObject({ stale: true, lost: 600 })
    // and back before SETTLE_MS: as it was, not stale
    const back = next(p, moved, 1200)
    expect(back.seen).toBe(moved.seen)
    expect(back).toMatchObject({ stale: false, lost: null, since: 500 })
  })

  it('drops it after SETTLE_MS and holds it', () => {
    const p = run([
      [model, 500],
      [gone, 600],
      [gone, 600 + SETTLE_MS],
    ])
    expect(p.seen).toBeNull()
    expect(p.held).toBe(model.seen)
    // the same window again is the one the panel's own cut keeps out, its title cut or not
    const again = next(p, moved, 2000)
    expect(again.seen).toBeNull()
    expect(again.held).toBe(model.seen)
    expect(next(p, cut, 2000).seen).toBeNull()
    // the input box ends the hold, and the window shows once more
    const free = next(again, idle, 2100)
    expect(free).toEqual({ ...NO_PANEL, held: null })
    expect(next(free, model, 2200).seen).toBe(model.seen)
  })

  it('shows another window while one is held', () => {
    const p = run([
      [model, 500],
      [gone, 600],
      [gone, 600 + SETTLE_MS],
      [btw, 1700],
    ])
    expect(p.seen).toBe(btw.seen)
    expect(p.held).toBeNull()
  })

  it('does not hold a window lost late', () => {
    const p = run([
      [model, 500],
      [gone, 2500],
      [gone, 2500 + SETTLE_MS],
    ])
    expect(p).toEqual(NO_PANEL)
    expect(next(p, model, 4000).seen).toBe(model.seen)
  })

  it('drops at once for the box', () => {
    expect(
      run([
        [model, 500],
        [idle, 600],
      ]),
    ).toEqual(NO_PANEL)
    expect(
      run([
        [model, 500],
        [gone, 600],
        [idle, 700],
      ]),
    ).toEqual(NO_PANEL)
  })

  it('stays empty with nothing to show', () => {
    expect(next(NO_PANEL, gone, 500)).toBe(NO_PANEL)
    expect(next(NO_PANEL, idle, 500)).toEqual(NO_PANEL)
  })

  it('holds a window lost late after its own resize', () => {
    const shown = next(NO_PANEL, model, 500)
    // the panel's height cut the terminal at 2400: what goes now is its doing
    const r = restart(shown, 2400)
    expect(r.since).toBe(2400)
    expect(r.seen).toBe(model.seen)
    const p = run(
      [
        [gone, 2500],
        [gone, 2500 + SETTLE_MS],
      ],
      r,
    )
    expect(p.seen).toBeNull()
    expect(p.held).toBe(model.seen)
  })

  it('leaves an empty panel as it is on restart', () => {
    expect(restart(NO_PANEL, 900)).toBe(NO_PANEL)
  })
})

describe('capOf', () => {
  it('gives the panel at most half the view and keeps the window on the terminal', () => {
    expect(capOf(0, 17, 10, 768, 0)).toBe(MIN_CAP)
    expect(MIN_CAP).toBe(120)
    expect(capOf(800, 17, 10, 900, 0)).toBe(450)
    expect(capOf(800, 17, 30, 2000, 0)).toBe(256)
  })

  it('leaves the terminal the room the panel\'s title and keys take', () => {
    // 1440×900: 32 rows of 19px, and the 16 rows of a 12-item /theme
    expect(capOf(608, 19, 16, 900, 92)).toBe(174)
    expect(capOf(800, 17, 30, 2000, 60)).toBe(196)
    expect(capOf(400, 17, 10, 900, 100)).toBe(MIN_CAP)
  })
})
