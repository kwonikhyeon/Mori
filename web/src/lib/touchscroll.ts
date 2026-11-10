// A finger scrolls the terminal (spec §3 #172). xterm.js 6.0 has no touch
// scrolling (6.1 brings its own, and this goes when Mori moves to it), so a
// drag over the terminal moved nothing on a phone. A vertical drag does what
// a PC's wheel does there: it moves through the scrollback, or, on the
// alternate screen and for a program that asked for the mouse, it reaches
// xterm as wheel events, which xterm turns into arrow keys or mouse reports.
// The box the terminal sits in keeps the drags it can still take, and a
// sideways drag stays the browser's: both pan a terminal larger than the
// screen (spec §3 #125). xterm's scrollbar is left to a mouse.

import type { Terminal } from '@xterm/xterm'

export interface TouchScrollOptions {
  /** One row's height in CSS pixels, 0 before the first render. */
  rowHeight(): number
  // The clock and the animation frames, for tests.
  now?: () => number
  frame?: (fn: () => void) => number
  cancelFrame?: (id: number) => void
}

/** How far a finger moves before the drag picks an axis: a tap moves less. */
const SLOP = 6
/** How fast a fling slows, in px/ms² (xterm 6.1's). */
const FRICTION = 0.005
/** The last stretch of a drag its speed at release is taken over, in ms. */
const RELEASE = 100
/** The mouse modes that report the wheel to the program. */
const WHEEL_MODES = new Set(['vt200', 'drag', 'any'])
/** xterm's scrollbars, each a track with a thumb. */
const SCROLLBAR = '.xterm-scrollable-element > .scrollbar'

type Drag = 'none' | 'open' | 'terminal' | 'browser'

export function touchScroll(el: HTMLElement, term: Terminal, o: TouchScrollOptions): () => void {
  const now = o.now ?? (() => performance.now())
  const frame = o.frame ?? ((fn) => requestAnimationFrame(fn))
  const cancelFrame = o.cancelFrame ?? ((id) => cancelAnimationFrame(id))
  let drag: Drag = 'none'
  let x0 = 0
  let y0 = 0
  let x = 0
  let y = 0
  /** This drag's row height. */
  let h = 0
  /** Pixels moved short of a whole row. */
  let rest = 0
  let track: { t: number; y: number }[] = []
  let fling = 0

  const wheel = () =>
    term.buffer.active.type === 'alternate' || WHEEL_MODES.has(term.modes.mouseTrackingMode)

  /** Follows the finger by px: down, to earlier lines, is positive. */
  function scroll(px: number): void {
    rest += px
    const rows = Math.trunc(rest / h)
    if (!rows) return
    rest -= rows * h
    if (!wheel()) {
      term.scrollLines(-rows)
      return
    }
    // A line each, as a wheel's clicks, sent where xterm listens for them.
    const xt = term.element
    if (!xt) return
    for (let i = 0; i < Math.abs(rows); i++) {
      xt.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: rows > 0 ? -1 : 1,
          deltaMode: WheelEvent.DOM_DELTA_LINE,
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
        }),
      )
    }
  }

  /** Whether the box around the terminal can still scroll back or on. */
  function boxScrolls(back: boolean): boolean {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const { overflowY } = getComputedStyle(p)
      if (overflowY !== 'auto' && overflowY !== 'scroll') continue
      return back ? p.scrollTop > 0 : p.scrollTop + p.clientHeight < p.scrollHeight - 1
    }
    return false
  }

  /** The finger's speed as it lifts, in px/ms: 0 if it rested first. */
  function release(): number {
    const t = now()
    const recent = track.filter((p) => t - p.t <= RELEASE)
    const a = recent[0]
    const b = recent[recent.length - 1]
    return a && b && b.t > a.t ? (b.y - a.y) / (b.t - a.t) : 0
  }

  function startFling(v: number): void {
    let t = now()
    const step = () => {
      const t1 = now()
      const dt = t1 - t
      t = t1
      scroll(v * dt)
      const speed = Math.abs(v) - FRICTION * dt
      if (speed <= 0) {
        fling = 0
        return
      }
      v = Math.sign(v) * speed
      fling = frame(step)
    }
    fling = frame(step)
  }

  function stopFling(): void {
    if (fling) cancelFrame(fling)
    fling = 0
  }

  function onMove(e: TouchEvent): void {
    if (drag !== 'open' && drag !== 'terminal') return
    if (e.touches.length !== 1) {
      drag = 'browser'
      return
    }
    const f = e.touches[0]
    if (drag === 'open') {
      const dx = f.clientX - x0
      const dy = f.clientY - y0
      if (Math.max(Math.abs(dx), Math.abs(dy)) < SLOP) return
      // Before its first render the terminal has no rows to move by.
      h = o.rowHeight()
      drag = h > 0 && Math.abs(dy) > Math.abs(dx) && !boxScrolls(dy > 0) ? 'terminal' : 'browser'
      if (drag === 'browser') return
    }
    if (e.cancelable) e.preventDefault()
    const dy = f.clientY - y
    x = f.clientX
    y = f.clientY
    track.push({ t: now(), y })
    scroll(dy)
  }

  function onEnd(e: TouchEvent): void {
    if (e.touches.length) return
    if (drag === 'terminal') {
      // A drag is no tap: no click, which would focus the terminal and
      // bring up the keyboard.
      if (e.cancelable) e.preventDefault()
      const v = release()
      if (v) startFling(v)
    }
    drag = 'none'
  }

  function onCancel(): void {
    drag = 'none'
  }

  // xterm's scrollbar takes a pointer pressed on it for its own drag, and
  // jumps there. It lies along the right edge, where a thumb scrolls, and
  // stays shown once tapped: a finger's press goes no further, and its drag
  // moves the lines as anywhere else. A touch outside the terminal hides it,
  // so a menu opened there still closes on a press along that edge.
  function onPress(e: PointerEvent): void {
    if (e.pointerType !== 'mouse' && e.target instanceof Element && e.target.closest(SCROLLBAR)) e.stopPropagation()
  }

  function onStart(e: TouchEvent): void {
    stopFling()
    // A gesture begun with two fingers is a pinch, the browser's to the end.
    drag = 'none'
    if (e.touches.length !== 1) return
    const f = e.touches[0]
    x0 = x = f.clientX
    y0 = y = f.clientY
    rest = 0
    track = [{ t: now(), y }]
    drag = 'open'
  }

  // Phones decide as a touch starts whether to wait for the page before they
  // scroll: the moves and the end are listened for from the start, and not
  // passively, or they could not be held still. xterm's rows take no touches
  // (pointer-events: none), so the finger's events come from its screen,
  // which stays put as the rows are drawn anew.
  el.addEventListener('touchstart', onStart, { passive: true })
  el.addEventListener('touchmove', onMove, { passive: false })
  el.addEventListener('touchend', onEnd, { passive: false })
  el.addEventListener('touchcancel', onCancel)
  el.addEventListener('pointerdown', onPress, { capture: true })
  return () => {
    stopFling()
    drag = 'none'
    el.removeEventListener('touchstart', onStart)
    el.removeEventListener('touchmove', onMove)
    el.removeEventListener('touchend', onEnd)
    el.removeEventListener('touchcancel', onCancel)
    el.removeEventListener('pointerdown', onPress, { capture: true })
  }
}
