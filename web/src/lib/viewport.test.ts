import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { editable, trackViewport } from './viewport'

/** A visual viewport the test resizes, as a keyboard or a browser's bars would. */
class FakeViewport extends EventTarget {
  width = 390
  height = 760
  scale = 1
  set(height: number, width = this.width): void {
    this.height = height
    this.width = width
    this.dispatchEvent(new Event('resize'))
  }
}

let vv: FakeViewport
let stop: () => void
const root = document.documentElement
const kb = () => root.classList.contains('kb')

beforeEach(() => {
  vi.useFakeTimers()
  vv = new FakeViewport()
  vi.stubGlobal('visualViewport', vv)
  vi.stubGlobal('scrollTo', () => {})
  stop = trackViewport()
})

afterEach(() => {
  stop()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('trackViewport', () => {
  it('follows the visual viewport', () => {
    expect(root.style.getPropertyValue('--app-h')).toBe('760px')
    vv.set(700.4)
    expect(root.style.getPropertyValue('--app-h')).toBe('700px')
  })

  it('says the keyboard is up while a field has the focus and the viewport is a keyboard shorter', () => {
    const box = document.createElement('textarea')
    document.body.append(box)
    box.focus()
    expect(kb()).toBe(false)
    vv.set(420)
    expect(kb()).toBe(true)
    // the keyboard slides out as the focus leaves
    box.blur()
    vv.set(760)
    expect(kb()).toBe(false)
  })

  it('does not take a browser bar, a field without a keyboard or a turned phone for a keyboard', () => {
    const box = document.createElement('input')
    document.body.append(box)
    box.focus()
    // the address bar comes back
    vv.set(700)
    expect(kb()).toBe(false)
    box.blur()
    vv.set(420)
    expect(kb()).toBe(false)
    // the phone turns: the wider viewport is shorter, with no keyboard
    box.focus()
    vv.set(360, 844)
    expect(kb()).toBe(false)
  })

  it('looks again once the focus has left, in case the viewport stays', () => {
    const box = document.createElement('textarea')
    document.body.append(box)
    box.focus()
    vv.set(420)
    expect(kb()).toBe(true)
    box.blur()
    expect(kb()).toBe(true)
    vi.advanceTimersByTime(400)
    expect(kb()).toBe(false)
  })

  it('leaves the root as it was when it stops', () => {
    const box = document.createElement('textarea')
    document.body.append(box)
    box.focus()
    vv.set(420)
    stop()
    expect(kb()).toBe(false)
    expect(root.style.getPropertyValue('--app-h')).toBe('')
    stop = () => {}
  })
})

describe('editable', () => {
  it('is a field a person types into', () => {
    const make = (html: string) => {
      document.body.innerHTML = html
      return document.body.firstElementChild
    }
    expect(editable(make('<textarea></textarea>'))).toBe(true)
    expect(editable(make('<input type="search">'))).toBe(true)
    expect(editable(make('<input type="checkbox">'))).toBe(false)
    expect(editable(make('<button>보내기</button>'))).toBe(false)
    expect(editable(null)).toBe(false)
  })
})
