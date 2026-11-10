import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { touchScroll } from './touchscroll'

// A real xterm, never opened: jsdom cannot lay it out, but its buffer, its
// modes and its scrolling are all there. A row is 10 px in these tests.

// As it loads, xterm asks for a canvas to read CSS colours by, and does
// without one. jsdom has none and says so; a browser without one is as quiet.
vi.hoisted(() => {
  HTMLCanvasElement.prototype.getContext = () => null
})

let host: HTMLElement
/** What the finger lands on: xterm's screen, inside the host. */
let span: HTMLElement
let term: Terminal
let off: () => void
let rowHeight: number
let now: number
let frames: Map<number, () => void>
let nextFrame: number

const write = (s: string) => new Promise<void>((r) => term.write(s, r))
/** The first line the screen shows: 26 is the newest, 0 the oldest. */
const top = () => term.buffer.active.viewportY

/** A touch event at the element under the finger, as a browser sends it. */
function send(type: string, points: [number, number][], at: Element = span): Event {
  const e = new Event(type, { bubbles: true, cancelable: true })
  const touches = points.map(([clientX, clientY], identifier) => ({ identifier, clientX, clientY, target: at }))
  Object.defineProperty(e, 'touches', { value: touches })
  at.dispatchEvent(e)
  return e
}
const down = (x: number, y: number) => send('touchstart', [[x, y]])
const move = (x: number, y: number) => send('touchmove', [[x, y]])
const up = () => send('touchend', [])

/** A pointer pressed on an element, as a browser sends it. */
const press = (at: Element, pointerType: string) =>
  at.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType }))

/** xterm's scrollbar as it lies in the terminal, and the presses it gets. */
function scrollbar(): { bar: HTMLElement; thumb: HTMLElement; got: string[] } {
  const pane = document.createElement('div')
  pane.className = 'xterm-scrollable-element'
  const bar = document.createElement('div')
  bar.className = 'scrollbar vertical visible'
  const thumb = document.createElement('div')
  thumb.className = 'slider'
  bar.append(thumb)
  pane.append(bar)
  host.append(pane)
  const got: string[] = []
  bar.addEventListener('pointerdown', (e) => got.push(e.pointerType))
  return { bar, thumb, got }
}

/** A quick flick down: 60 px in 48 ms, six rows back to line 20. */
function flick(): void {
  down(50, 100)
  for (const y of [120, 140, 160]) {
    now += 16
    move(50, y)
  }
  up()
}

/** Runs the animation frames asked for, 16 ms apart, until none is left. */
function play(max = 1000): void {
  for (let i = 0; i < max && frames.size; i++) {
    const [id, fn] = frames.entries().next().value!
    frames.delete(id)
    now += 16
    fn()
  }
}

beforeEach(async () => {
  host = document.createElement('div')
  span = document.createElement('span')
  host.append(span)
  document.body.append(host)
  term = new Terminal({ cols: 20, rows: 5, scrollback: 100 })
  // 30 lines and the empty one under them: the screen shows lines 26 to 30.
  let lines = ''
  for (let i = 1; i <= 30; i++) lines += `line ${i}\r\n`
  await write(lines)
  rowHeight = 10
  now = 0
  frames = new Map()
  nextFrame = 1
  off = touchScroll(host, term, {
    rowHeight: () => rowHeight,
    now: () => now,
    frame: (fn) => {
      frames.set(nextFrame, fn)
      return nextFrame++
    },
    cancelFrame: (id) => {
      frames.delete(id)
    },
  })
})

afterEach(() => {
  off()
  term.dispose()
  document.body.replaceChildren()
})

describe('touchScroll', () => {
  test('a finger drawn down brings back earlier lines, a row for each row height', () => {
    expect(top()).toBe(26)
    down(50, 100)
    const moves = [move(50, 115), move(50, 130)]
    expect(top()).toBe(23)
    // The page does not move under the finger as well.
    expect(moves.map((e) => e.defaultPrevented)).toEqual([true, true])
  })

  test('drawn up, it goes back toward the newest lines', () => {
    term.scrollLines(-10)
    down(50, 100)
    move(50, 80)
    expect(top()).toBe(18)
  })

  test('at the newest line a drag up still holds the page still', () => {
    down(50, 100)
    const m = move(50, 70)
    expect(top()).toBe(26)
    expect(m.defaultPrevented).toBe(true)
  })

  test('a sideways drag is left to the browser, which pans a wide terminal', () => {
    down(50, 100)
    const moves = [move(70, 104), move(90, 110)]
    expect(top()).toBe(26)
    expect(moves.map((e) => e.defaultPrevented)).toEqual([false, false])
  })

  test('a touch that barely moves stays a tap', () => {
    down(50, 100)
    const m = move(51, 104)
    const end = up()
    expect(top()).toBe(26)
    expect([m.defaultPrevented, end.defaultPrevented]).toEqual([false, false])
    expect(frames.size).toBe(0)
  })

  test('a drag ends without a click, which would bring up the keyboard', () => {
    down(50, 100)
    move(50, 130)
    expect(up().defaultPrevented).toBe(true)
  })

  test('the box around a terminal taller than the screen scrolls first', () => {
    const box = document.createElement('div')
    box.style.overflowY = 'auto'
    box.append(host)
    document.body.append(box)
    const at = (scrollTop: number) =>
      Object.defineProperties(box, {
        scrollTop: { value: scrollTop, configurable: true },
        clientHeight: { value: 200, configurable: true },
        scrollHeight: { value: 300, configurable: true },
      })
    // Whether the terminal took a drag, and where it is after it.
    const drag = (y: number) => {
      down(50, 100)
      const m = move(50, y)
      up()
      return [m.defaultPrevented, top()]
    }
    term.scrollLines(-10)

    at(40)
    expect(drag(130)).toEqual([false, 16])
    expect(drag(70)).toEqual([false, 16])
    at(0)
    expect(drag(130)).toEqual([true, 13])
    expect(drag(70)).toEqual([false, 13])
    at(100)
    expect(drag(130)).toEqual([false, 13])
    expect(drag(70)).toEqual([true, 16])
  })

  test('a box within a pixel of its end is at its end', () => {
    // Its height is a whole number of pixels; where it stops need not be.
    const box = document.createElement('div')
    box.style.overflowY = 'auto'
    box.append(host)
    document.body.append(box)
    Object.defineProperties(box, {
      scrollTop: { value: 99.5 },
      clientHeight: { value: 200 },
      scrollHeight: { value: 300 },
    })
    term.scrollLines(-10)
    down(50, 100)
    const m = move(50, 70)
    expect([m.defaultPrevented, top()]).toEqual([true, 19])
  })

  test('a fling keeps the lines going after the finger lifts, then stops', () => {
    flick()
    expect(top()).toBe(20)
    play()
    expect(top()).toBeLessThan(20)
    expect(frames.size).toBe(0)
  })

  test('a finger that rests before it lifts does not fling', () => {
    down(50, 100)
    for (const y of [120, 140]) {
      now += 16
      move(50, y)
    }
    now += 300
    up()
    play()
    expect(top()).toBe(22)
  })

  test('a new touch catches a fling', () => {
    flick()
    play(2)
    const caught = top()
    expect(caught).toBeLessThan(20)
    down(50, 300)
    play()
    expect(top()).toBe(caught)
  })

  test('two fingers are left to the browser', () => {
    send('touchstart', [[50, 100], [90, 100]])
    const m = send('touchmove', [[50, 130], [90, 130]])
    expect(top()).toBe(26)
    expect(m.defaultPrevented).toBe(false)
  })

  test('a second finger, wherever it lands, hands the drag to the browser', () => {
    down(50, 100)
    move(50, 115)
    // This one lands outside the terminal: only the first finger's moves
    // tell of it.
    const two = send('touchmove', [[50, 130], [200, 500]])
    const one = move(50, 160)
    expect(top()).toBe(25)
    expect([two.defaultPrevented, one.defaultPrevented]).toEqual([false, false])
  })

  test('a gesture begun with two fingers stays the browser’s once one lifts', () => {
    send('touchstart', [[50, 100], [50, 140]])
    send('touchend', [[50, 140]])
    const m = move(50, 170)
    expect(top()).toBe(26)
    expect(m.defaultPrevented).toBe(false)
  })

  test('it listens, and not passively, before a finger lands', () => {
    // A phone decides as a touch starts whether it must wait for the page
    // before it scrolls: a listener added once the finger is down comes too
    // late to hold the page still.
    const el = document.createElement('div')
    const spy = vi.spyOn(el, 'addEventListener')
    const stop = touchScroll(el, term, { rowHeight: () => 10 })
    const held = spy.mock.calls.filter(([, , opt]) => typeof opt === 'object' && opt.passive === false).map(([type]) => type)
    stop()
    expect(held).toEqual(expect.arrayContaining(['touchmove', 'touchend']))
  })

  test('before the first render, a drag is left to the browser', () => {
    // No rows to move by yet.
    rowHeight = 0
    down(50, 100)
    const m = move(50, 130)
    expect([top(), m.defaultPrevented]).toEqual([26, false])
  })

  test.each([
    ['no mouse', '', false],
    ['clicks only (X10)', '\x1b[?9h', false],
    ['the alternate screen', '\x1b[?1049h', true],
    ['clicks and the wheel (VT200)', '\x1b[?1000h', true],
    ['drags', '\x1b[?1002h', true],
    ['every motion', '\x1b[?1003h', true],
  ])('with %s, a drag goes where a PC wheel would', async (_, mode, wheel) => {
    await write(mode)
    // The element xterm listens for the wheel on once it is opened.
    const el = document.createElement('div')
    Object.defineProperty(term, 'element', { get: () => el })
    const got: number[][] = []
    el.addEventListener('wheel', (e) => got.push([e.deltaY, e.deltaMode, e.clientX, e.clientY]))
    const before = top()
    down(50, 100)
    move(50, 130)
    if (wheel) {
      // Three lines up, as three clicks of a wheel, where the finger is.
      expect(got).toEqual([
        [-1, WheelEvent.DOM_DELTA_LINE, 50, 130],
        [-1, WheelEvent.DOM_DELTA_LINE, 50, 130],
        [-1, WheelEvent.DOM_DELTA_LINE, 50, 130],
      ])
      expect(top()).toBe(before)
    } else {
      expect(got).toEqual([])
      expect(top()).toBe(before - 3)
    }
  })

  test('a finger on xterm’s scrollbar drags the lines, not the scrollbar', () => {
    // The scrollbar takes a pointer pressed on it for its own drag, and jumps
    // there: at the right edge, where a thumb scrolls, the lines would go one
    // way and the scrollbar the other.
    const { bar, thumb, got } = scrollbar()
    press(thumb, 'touch')
    press(bar, 'touch')
    press(thumb, 'pen')
    expect(got).toEqual([])
    send('touchstart', [[50, 100]], thumb)
    send('touchmove', [[50, 130]], thumb)
    expect(top()).toBe(23)
  })

  test('only the scrollbar is kept from a finger’s press', () => {
    const { bar, thumb, got } = scrollbar()
    // A mouse still works the scrollbar.
    press(thumb, 'mouse')
    press(bar, 'mouse')
    expect(got).toEqual(['mouse', 'mouse'])
    // A finger pressed on the lines goes on as ever: an open menu closes on it.
    const seen: string[] = []
    const record = (e: PointerEvent) => seen.push(e.pointerType)
    document.addEventListener('pointerdown', record)
    press(span, 'touch')
    document.removeEventListener('pointerdown', record)
    expect(seen).toEqual(['touch'])
  })

  test('once disposed, it stops a fling and lets the finger be', () => {
    const { bar, got } = scrollbar()
    flick()
    off()
    play()
    expect(top()).toBe(20)
    down(50, 100)
    const m = move(50, 130)
    expect([top(), m.defaultPrevented]).toEqual([20, false])
    // The scrollbar has a finger's press back.
    press(bar, 'touch')
    expect(got).toEqual(['touch'])
  })
})
