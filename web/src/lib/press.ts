// The touch half of a press (spec §3 #204), after astryx's pressFeedback.
// One listener on the document writes data-press on the control a finger
// holds, and base.css paints it with the pressed overlay. A touch screen gets
// no :active (base.css keeps that for a mouse): :active paints on the touch
// and outlives a scroll, so a list would flash under a thumb that only
// scrolls.
//
// A finger waits only inside a scroller. Outside one, the control lights in
// the frame the finger lands; inside one, it waits 150 ms, since the touch
// may become a scroll. A scroll of that scroller, or 10 px of travel, takes
// the press away, and a tap that lifts inside the wait flashes for 100 ms so
// it is seen. A touch that stops a list still gliding (it moved under 150 ms
// before) only stops it.

const PRESSABLE = 'button, [role="button"], a[class], label[class]'
const DISABLED = ':disabled, [aria-disabled="true"]'
export const ONSET_MS = 150
export const SLOP_PX = 10
export const FLASH_MS = 100
export const BRAKE_MS = 150

interface Press {
  el: HTMLElement
  pointer: number
  x: number
  y: number
  /** The wait inside a scroller, until the control lights. */
  onset: number | null
}

let press: Press | null = null
let flash: { el: HTMLElement; timer: number } | null = null
let scrolled: { at: number; scroller: Node } | null = null

function paint(el: HTMLElement, on: boolean): void {
  if (on) el.setAttribute('data-press', '')
  else el.removeAttribute('data-press')
}

function overflows(el: Element, style: CSSStyleDeclaration): boolean {
  const scrolls = (v: string) => v === 'auto' || v === 'scroll'
  return (scrolls(style.overflowY) && el.scrollHeight > el.clientHeight + 1) || (scrolls(style.overflowX) && el.scrollWidth > el.clientWidth + 1)
}

/** Whether a box above `el` scrolls, the page included; a fixed box ends the walk. */
function insideScroller(el: Element): boolean {
  const root = document.scrollingElement ?? document.documentElement
  for (let node = el.parentElement; node && node !== root && node !== document.body; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (overflows(node, style)) return true
    if (style.position === 'fixed') return false
  }
  return root.scrollHeight > root.clientHeight + 1
}

function stopFlash(): void {
  if (!flash) return
  clearTimeout(flash.timer)
  paint(flash.el, false)
  flash = null
}

/** Ends the press without a flash: a scroll, travel or a cancel took it. */
function cancel(): void {
  if (!press) return
  if (press.onset !== null) clearTimeout(press.onset)
  paint(press.el, false)
  press = null
}

function down(e: PointerEvent): void {
  if (e.pointerType === 'mouse' || !e.isPrimary) return
  cancel()
  stopFlash()
  const el = e.target instanceof Element ? e.target.closest<HTMLElement>(PRESSABLE) : null
  if (!el || el.matches(DISABLED)) return
  if (scrolled && performance.now() - scrolled.at < BRAKE_MS && scrolled.scroller.contains(el)) return
  const p: Press = { el, pointer: e.pointerId, x: e.clientX, y: e.clientY, onset: null }
  press = p
  if (insideScroller(el)) {
    p.onset = window.setTimeout(() => {
      p.onset = null
      paint(el, true)
    }, ONSET_MS)
  } else paint(el, true)
}

function move(e: PointerEvent): void {
  if (press?.pointer === e.pointerId && Math.hypot(e.clientX - press.x, e.clientY - press.y) > SLOP_PX) cancel()
}

function up(e: PointerEvent): void {
  if (press?.pointer !== e.pointerId) return
  const { el, onset } = press
  press = null
  if (onset === null) {
    paint(el, false)
    return
  }
  clearTimeout(onset)
  paint(el, true)
  flash = {
    el,
    timer: window.setTimeout(() => {
      flash = null
      paint(el, false)
    }, FLASH_MS),
  }
}

function scroll(e: Event): void {
  const scroller = e.target === document ? (document.scrollingElement ?? document.documentElement) : e.target
  if (!(scroller instanceof Node)) return
  scrolled = { at: performance.now(), scroller }
  if (press && scroller.contains(press.el)) cancel()
}

function hide(): void {
  if (document.visibilityState === 'hidden') cancel()
}

/** Starts the listener; the function it gives back stops it (for tests). */
export function initPress(): () => void {
  const opts = { capture: true, passive: true }
  const cancelled = (e: PointerEvent) => {
    if (press?.pointer === e.pointerId) cancel()
  }
  document.addEventListener('pointerdown', down, opts)
  document.addEventListener('pointermove', move, opts)
  document.addEventListener('pointerup', up, opts)
  document.addEventListener('pointercancel', cancelled, opts)
  document.addEventListener('scroll', scroll, opts)
  document.addEventListener('visibilitychange', hide)
  return () => {
    document.removeEventListener('pointerdown', down, opts)
    document.removeEventListener('pointermove', move, opts)
    document.removeEventListener('pointerup', up, opts)
    document.removeEventListener('pointercancel', cancelled, opts)
    document.removeEventListener('scroll', scroll, opts)
    document.removeEventListener('visibilitychange', hide)
    cancel()
    stopFlash()
    scrolled = null
  }
}
