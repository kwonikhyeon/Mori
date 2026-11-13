import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BRIDGE_MS, initTips, SHOW_MS, tip } from './tip'

let stop = () => {}
let btn: HTMLButtonElement

/** A pointer event of a kind: jsdom's PointerEvent may be missing, so a MouseEvent with the kind on it. */
function pointer(type: string, on: Element, kind = 'mouse', related: Element | null = null) {
  const e = new MouseEvent(type, { bubbles: true, relatedTarget: related })
  Object.defineProperty(e, 'pointerType', { value: kind })
  on.dispatchEvent(e)
}

const shown = () => {
  const t = document.querySelector<HTMLElement>('[role="tooltip"]')!
  return t.hidden ? null : t.textContent
}

beforeEach(() => {
  vi.useFakeTimers()
  stop = initTips()
  btn = document.createElement('button')
  for (const [k, v] of Object.entries(tip('새로 고침'))) btn.setAttribute(k, v)
  btn.innerHTML = '<svg></svg>'
  document.body.append(btn)
})

afterEach(() => {
  stop()
  btn.remove()
  vi.useRealTimers()
})

// spec §3 #247, after astryx's Tooltip
describe('the tooltip', () => {
  it('names the control and shows its name 200 ms after a mouse comes on it', () => {
    expect(btn.getAttribute('aria-label')).toBe('새로 고침')
    pointer('pointerover', btn.firstElementChild!)
    vi.advanceTimersByTime(SHOW_MS - 1)
    expect(shown()).toBeNull()
    vi.advanceTimersByTime(1)
    expect(shown()).toBe('새로 고침')
  })

  it('stays while the mouse moves inside the control or onto the tooltip, and goes once it leaves', () => {
    pointer('pointerover', btn)
    vi.advanceTimersByTime(SHOW_MS)
    pointer('pointerout', btn.firstElementChild!, 'mouse', btn)
    vi.advanceTimersByTime(BRIDGE_MS)
    expect(shown()).toBe('새로 고침')
    const t = document.querySelector('[role="tooltip"]')!
    pointer('pointerout', btn, 'mouse', t)
    pointer('pointerover', t)
    vi.advanceTimersByTime(BRIDGE_MS)
    expect(shown()).toBe('새로 고침')
    pointer('pointerout', t, 'mouse', document.body)
    vi.advanceTimersByTime(BRIDGE_MS)
    expect(shown()).toBeNull()
  })

  it('does not wait out a mouse that only passed over it', () => {
    pointer('pointerover', btn)
    pointer('pointerout', btn, 'mouse', document.body)
    vi.advanceTimersByTime(SHOW_MS + BRIDGE_MS)
    expect(shown()).toBeNull()
  })

  it('is not opened by a finger, and a press or Escape hides it', () => {
    pointer('pointerover', btn, 'touch')
    vi.advanceTimersByTime(SHOW_MS)
    expect(shown()).toBeNull()
    pointer('pointerover', btn)
    vi.advanceTimersByTime(SHOW_MS)
    pointer('pointerdown', btn)
    expect(shown()).toBeNull()
    pointer('pointerover', document.body)
    pointer('pointerover', btn)
    vi.advanceTimersByTime(SHOW_MS)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(shown()).toBeNull()
  })

  it('shows at once for keyboard focus, not for the focus a click leaves', () => {
    const visible = vi.spyOn(btn, 'matches').mockImplementation((s: string) => s === ':focus-visible')
    btn.focus()
    expect(shown()).toBe('새로 고침')
    btn.blur()
    expect(shown()).toBeNull()
    visible.mockReturnValue(false)
    btn.focus()
    expect(shown()).toBeNull()
  })
})
