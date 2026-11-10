import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { backSwipe, type BackSwipeOptions } from './backswipe'

let root: HTMLElement
/** What the finger lands on, inside root. */
let span: HTMLElement
let stop: () => void
let back: Mock<() => void>
let now: number
let frames: Map<number, () => void>
let nextFrame: number

/** A touch event at the element under the finger, as a browser sends it. */
function send(type: string, points: [number, number][], at: Element = span): Event {
  const e = new Event(type, { bubbles: true, cancelable: true })
  const touches = points.map(([clientX, clientY], identifier) => ({ identifier, clientX, clientY, target: at }))
  Object.defineProperty(e, 'touches', { value: touches })
  at.dispatchEvent(e)
  return e
}
const down = (x: number, y = 100, at?: Element) => send('touchstart', [[x, y]], at)
const move = (x: number, y = 100, at?: Element) => {
  now += 16
  return send('touchmove', [[x, y]], at)
}
const up = () => send('touchend', [])

/** Runs the animation frames asked for. */
function play(): void {
  for (const [id, fn] of [...frames]) {
    frames.delete(id)
    fn()
  }
}

/** The transition's end, as the browser sends it. */
const slid = () => root.dispatchEvent(new Event('transitionend', { bubbles: true }))

function start(over: Partial<BackSwipeOptions> = {}) {
  stop = backSwipe(root, {
    back,
    reduced: () => false,
    now: () => now,
    frame: (fn) => {
      frames.set(++nextFrame, fn)
      return nextFrame
    },
    cancelFrame: (id) => frames.delete(id),
    ...over,
  })
}

/** A slow drag from x 40 to x, 100 ms a step. */
function drag(to: number) {
  down(40)
  for (let x = 40; x < to; ) {
    x = Math.min(to, x + 30)
    now += 84
    move(x)
  }
}

beforeEach(() => {
  root = document.body.appendChild(document.createElement('div'))
  span = root.appendChild(document.createElement('span'))
  back = vi.fn<() => void>()
  now = 1_000
  frames = new Map()
  nextFrame = 0
  start()
})

afterEach(() => {
  stop()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('backSwipe', () => {
  it('follows the finger and goes back once the screen has slid out', () => {
    down(40)
    expect(move(46).defaultPrevented).toBe(false) // a tap moves less
    const held = move(60, 102)
    expect(held.defaultPrevented).toBe(true)
    move(160, 104)
    expect(root.classList.contains('is-swiping')).toBe(true)
    play()
    expect(root.style.transform).toBe('translate3d(120px, 0, 0)')
    expect(Number(root.style.opacity)).toBeCloseTo(1 - 0.3 * (120 / 1024))
    expect(up().defaultPrevented).toBe(true)
    // jsdom lays nothing out: the window's width.
    expect(root.style.transform).toBe('translate3d(1024px, 0, 0)')
    expect(root.style.transition).toContain('transform 180ms')
    expect(back).not.toHaveBeenCalled()
    span.dispatchEvent(new Event('transitionend', { bubbles: true })) // a button's, inside
    expect(back).not.toHaveBeenCalled()
    slid()
    expect(back).toHaveBeenCalledTimes(1)
    expect(root.getAttribute('style') ?? '').toBe('')
    expect(root.classList.contains('is-swiping')).toBe(false)
    slid()
    expect(back).toHaveBeenCalledTimes(1)
  })

  it('goes back where it was from a short slow drag', () => {
    drag(100)
    up()
    expect(root.style.transform).toBe('translate3d(0px, 0, 0)')
    slid()
    expect(back).not.toHaveBeenCalled()
    expect(root.getAttribute('style') ?? '').toBe('')
  })

  it('goes back from a flick', () => {
    down(40)
    move(52)
    move(70)
    move(90)
    up()
    slid()
    expect(back).toHaveBeenCalledTimes(1)
  })

  it('does not take a flick that turned back', () => {
    down(40)
    move(100)
    move(130)
    now += 200
    move(110)
    move(90)
    up()
    slid()
    expect(back).not.toHaveBeenCalled()
  })

  it('goes on when the transition never ends', () => {
    vi.useFakeTimers()
    drag(200)
    up()
    vi.advanceTimersByTime(239)
    expect(back).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(back).toHaveBeenCalledTimes(1)
  })

  it('goes back at once, with no slide, for reduced motion', () => {
    stop()
    start({ reduced: () => true })
    drag(200)
    up()
    expect(back).toHaveBeenCalledTimes(1)
    expect(root.getAttribute('style') ?? '').toBe('')
  })

  it('leaves the left edge to the browser, and the fields, the keys and the compose box to themselves', () => {
    down(12)
    expect(move(140).defaultPrevented).toBe(false)
    up()
    for (const tag of ['textarea', 'input']) {
      const f = root.appendChild(document.createElement(tag))
      down(40, 100, f)
      expect(move(140, 100, f).defaultPrevented).toBe(false)
      send('touchend', [], f)
    }
    for (const cls of ['term-keys', 'term-compose']) {
      const box = root.appendChild(document.createElement('div'))
      box.className = cls
      const b = box.appendChild(document.createElement('button'))
      down(40, 100, b)
      expect(move(140, 100, b).defaultPrevented).toBe(false)
      send('touchend', [], b)
    }
    expect(back).not.toHaveBeenCalled()
    expect(frames.size).toBe(0)
  })

  it('takes no drag while blocked, up or down, leftwards, or one the terminal took', () => {
    let blocked = true
    stop()
    start({ blocked: () => blocked })
    down(40)
    expect(move(140).defaultPrevented).toBe(false)
    up()
    blocked = false
    down(40)
    expect(move(60, 130).defaultPrevented).toBe(false) // more down than across
    expect(move(200, 130).defaultPrevented).toBe(false) // and it stays so
    up()
    down(200)
    expect(move(170).defaultPrevented).toBe(false)
    up()
    span.addEventListener('touchmove', (e) => e.preventDefault(), { once: true })
    down(40)
    move(60)
    expect(move(140).defaultPrevented).toBe(false)
    up()
    expect(root.classList.contains('is-swiping')).toBe(false)
  })

  it('leaves a drag to a box that can still scroll back to the left', () => {
    const box = root.appendChild(document.createElement('div'))
    box.style.overflowX = 'auto'
    Object.defineProperty(box, 'scrollWidth', { value: 900 })
    Object.defineProperty(box, 'clientWidth', { value: 390 })
    const cell = box.appendChild(document.createElement('span'))
    box.scrollLeft = 30
    Object.defineProperty(box, 'scrollLeft', { value: 30, configurable: true })
    down(40, 100, cell)
    expect(move(140, 100, cell).defaultPrevented).toBe(false)
    send('touchend', [], cell)
    Object.defineProperty(box, 'scrollLeft', { value: 0 })
    down(40, 100, cell)
    move(60, 100, cell)
    expect(move(140, 100, cell).defaultPrevented).toBe(true)
  })

  it('goes back where it was for a second finger or a cancel', () => {
    drag(200)
    send('touchstart', [
      [200, 100],
      [260, 120],
    ])
    expect(root.style.transform).toBe('translate3d(0px, 0, 0)')
    slid()
    up()
    drag(200)
    send('touchcancel', [])
    slid()
    expect(back).not.toHaveBeenCalled()
    expect(root.getAttribute('style') ?? '').toBe('')
  })

  it('starts no swipe while the screen slides', () => {
    drag(200)
    up()
    down(40)
    expect(move(140).defaultPrevented).toBe(false)
    slid()
    expect(back).toHaveBeenCalledTimes(1)
  })

  it('stops, and puts the screen back', () => {
    drag(200)
    play()
    stop()
    expect(root.getAttribute('style') ?? '').toBe('')
    expect(root.classList.contains('is-swiping')).toBe(false)
    down(40)
    expect(move(140).defaultPrevented).toBe(false)
    stop = () => {}
  })
})
