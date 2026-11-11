import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BRAKE_MS, FLASH_MS, initPress, ONSET_MS, SLOP_PX } from './press'

let stop: () => void

function pointer(type: string, target: Element, { x = 10, y = 10, id = 1, kind = 'touch', primary = true } = {}) {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: kind, pointerId: id, isPrimary: primary, clientX: x, clientY: y }))
}

/** A box that scrolls: the test DOM lays nothing out, so it says its sizes. */
function scroller(): HTMLElement {
  const box = document.createElement('div')
  box.style.overflowY = 'auto'
  Object.defineProperty(box, 'scrollHeight', { value: 400 })
  Object.defineProperty(box, 'clientHeight', { value: 200 })
  document.body.appendChild(box)
  return box
}

function button(parent: Element = document.body): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  parent.appendChild(b)
  return b
}

const pressed = (el: Element) => el.hasAttribute('data-press')

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  stop = initPress()
})

afterEach(() => {
  stop()
  vi.useRealTimers()
  document.body.replaceChildren()
})

describe('the touch press', () => {
  it('lights a control outside a scroller as the finger lands, and lets go at the lift', () => {
    const b = button()
    pointer('pointerdown', b)
    expect(pressed(b)).toBe(true)
    pointer('pointerup', b)
    expect(pressed(b)).toBe(false)
  })

  it('lights the control a finger holds, not the icon in it', () => {
    const a = document.createElement('a')
    a.className = 'row'
    const icon = document.createElement('span')
    a.appendChild(icon)
    document.body.appendChild(a)
    pointer('pointerdown', icon)
    expect(pressed(a)).toBe(true)
    expect(pressed(icon)).toBe(false)
  })

  it('waits inside a scroller, since the touch may become a scroll', () => {
    const b = button(scroller())
    pointer('pointerdown', b)
    vi.advanceTimersByTime(ONSET_MS - 1)
    expect(pressed(b)).toBe(false)
    vi.advanceTimersByTime(1)
    expect(pressed(b)).toBe(true)
    pointer('pointerup', b)
    expect(pressed(b)).toBe(false)
  })

  it('flashes a tap that lifts inside the wait, so it is seen', () => {
    const b = button(scroller())
    pointer('pointerdown', b)
    vi.advanceTimersByTime(ONSET_MS / 2)
    pointer('pointerup', b)
    expect(pressed(b)).toBe(true)
    vi.advanceTimersByTime(FLASH_MS)
    expect(pressed(b)).toBe(false)
  })

  it('takes the press away once the finger travels past the slop', () => {
    const b = button()
    pointer('pointerdown', b, { y: 10 })
    pointer('pointermove', b, { y: 10 + SLOP_PX })
    expect(pressed(b)).toBe(true)
    pointer('pointermove', b, { y: 11 + SLOP_PX })
    expect(pressed(b)).toBe(false)
    pointer('pointerup', b)
    expect(pressed(b)).toBe(false)
  })

  it('takes the press away when its own scroller scrolls, not another', () => {
    const box = scroller()
    const b = button(box)
    pointer('pointerdown', b)
    vi.advanceTimersByTime(ONSET_MS)
    scroller().dispatchEvent(new Event('scroll'))
    expect(pressed(b)).toBe(true)
    box.dispatchEvent(new Event('scroll'))
    expect(pressed(b)).toBe(false)
    // A scroll inside the wait: nothing lights, and the lift flashes nothing.
    vi.advanceTimersByTime(BRAKE_MS)
    pointer('pointerdown', b)
    box.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(ONSET_MS)
    pointer('pointerup', b)
    expect(pressed(b)).toBe(false)
  })

  it('only stops a list still gliding', () => {
    const box = scroller()
    const b = button(box)
    box.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(BRAKE_MS - 1)
    pointer('pointerdown', b)
    vi.advanceTimersByTime(ONSET_MS)
    expect(pressed(b)).toBe(false)
    pointer('pointerup', b)
    pointer('pointerdown', b)
    vi.advanceTimersByTime(ONSET_MS)
    expect(pressed(b)).toBe(true)
  })

  it('lets go when the browser cancels the touch', () => {
    const b = button()
    pointer('pointerdown', b)
    pointer('pointercancel', b)
    expect(pressed(b)).toBe(false)
  })

  it('leaves a mouse to :active, and lights nothing that is off or a second finger', () => {
    const b = button()
    pointer('pointerdown', b, { kind: 'mouse' })
    expect(pressed(b)).toBe(false)
    pointer('pointerdown', b, { id: 2, primary: false })
    expect(pressed(b)).toBe(false)
    const off = button()
    off.disabled = true
    pointer('pointerdown', off)
    expect(pressed(off)).toBe(false)
    const aria = button()
    aria.setAttribute('aria-disabled', 'true')
    pointer('pointerdown', aria)
    expect(pressed(aria)).toBe(false)
  })
})
