// A finger drawn rightwards across a phone's full screen goes back where its
// ‹ goes (spec §3 #200), as Safari's own swipe does, which a home-screen app
// does not have. The strip along the left edge stays the browser's. A drag a
// field, the quick keys or the compose box starts, one a box scrolled
// sideways can still take, and one the terminal took for its scroll stay
// theirs; so does any drag while a menu or a dialog is open.

export interface BackSwipeOptions {
  /** Goes back; called once the screen has slid out. */
  back: () => void
  /** Whether no swipe may start now. */
  blocked?: () => boolean
  /** Whether motion is kept to what the finger does itself. */
  reduced?: () => boolean
  // The clock and the animation frames, for tests.
  now?: () => number
  frame?: (fn: () => void) => number
  cancelFrame?: (id: number) => void
}

/** The strip along the left edge left to the browser, in CSS px. */
const EDGE = 20
/** How far a finger moves before the swipe picks an axis: a tap moves less. */
const SLOP = 10
/** How far it goes to go back when it does not flick. */
const MIN = 80
/** How fast a flick goes, in px/ms. */
const FLICK = 0.5
/** The last stretch of the swipe its speed at release is taken over, in ms. */
const RELEASE = 100
/** How long the screen takes to slide out or back, in ms. */
const SLIDE = 180
/** How long it waits for the slide's end before it goes on anyway, in ms. */
const SLIDE_MAX = 240
/** How faint the screen gets on its way out. */
const FADE = 0.3

/** Where a swipe does not start. */
const OWN = '.term-keys, .term-compose, input, textarea, select, [contenteditable]:not([contenteditable="false"])'

type Drag = 'none' | 'open' | 'x' | 'off'

const reducedMotion = () => !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/** Whether a box between the finger and root could still scroll back to the left. */
function scrollsLeft(t: EventTarget | null, root: HTMLElement): boolean {
  for (let el = t instanceof Element ? t : null; el; el = el.parentElement) {
    const { overflowX } = getComputedStyle(el)
    if ((overflowX === 'auto' || overflowX === 'scroll') && el.scrollWidth - el.clientWidth > 1 && el.scrollLeft > 0) return true
    if (el === root) break
  }
  return false
}

/** Listens on root, the full screen that slides; the returned function stops it. */
export function backSwipe(root: HTMLElement, o: BackSwipeOptions): () => void {
  const now = o.now ?? (() => performance.now())
  const frame = o.frame ?? ((fn) => requestAnimationFrame(fn))
  const cancelFrame = o.cancelFrame ?? ((id) => cancelAnimationFrame(id))
  const reduced = o.reduced ?? reducedMotion
  let drag: Drag = 'none'
  let x0 = 0
  let y0 = 0
  /** How far right the screen is. */
  let dx = 0
  /** The screen's width, taken as the swipe starts. */
  let w = 1
  let track: { t: number; x: number }[] = []
  let raf = 0
  /** Set while the screen slides out or back on its own. */
  let slide: { go: boolean; timer: ReturnType<typeof setTimeout> } | null = null

  const fade = (x: number) => String(1 - FADE * Math.min(1, x / w))

  function paint(): void {
    if (raf) return
    raf = frame(() => {
      raf = 0
      root.style.transform = `translate3d(${dx}px, 0, 0)`
      root.style.opacity = fade(dx)
    })
  }

  function stopPaint(): void {
    if (raf) cancelFrame(raf)
    raf = 0
  }

  function clear(): void {
    stopPaint()
    root.classList.remove('is-swiping')
    root.style.removeProperty('transform')
    root.style.removeProperty('opacity')
    root.style.removeProperty('transition')
  }

  /** The finger's speed rightwards as it lifts, in px/ms: 0 if it rested first. */
  function speed(): number {
    const t = now()
    const recent = track.filter((p) => t - p.t <= RELEASE)
    const a = recent[0]
    const b = recent[recent.length - 1]
    return a && b && b.t > a.t ? (b.x - a.x) / (b.t - a.t) : 0
  }

  /** The screen goes out (go) or back where it was, then the swipe ends. */
  function settle(go: boolean): void {
    stopPaint()
    if (reduced()) {
      end(go)
      return
    }
    const timer = setTimeout(() => end(go), SLIDE_MAX)
    slide = { go, timer }
    root.style.transition = `transform ${SLIDE}ms ease-out, opacity ${SLIDE}ms ease-out`
    root.style.transform = `translate3d(${go ? w : 0}px, 0, 0)`
    root.style.opacity = fade(go ? w : 0)
  }

  // The screen is put back in the same task as it goes back, so the next
  // screen, made before the next frame, is not drawn moved. One that stays
  // has its place back.
  function end(go: boolean): void {
    if (slide) clearTimeout(slide.timer)
    slide = null
    dx = 0
    clear()
    if (go) o.back()
  }

  function onSlid(e: Event): void {
    if (slide && e.target === root) end(slide.go)
  }

  function onStart(e: TouchEvent): void {
    // A second finger is a pinch: the swipe goes back where it was.
    if (drag === 'x') settle(false)
    drag = 'none'
    if (slide || e.touches.length !== 1 || o.blocked?.()) return
    const f = e.touches[0]
    if (f.clientX < EDGE || (e.target instanceof Element && e.target.closest(OWN))) return
    x0 = f.clientX
    y0 = f.clientY
    dx = 0
    track = [{ t: now(), x: x0 }]
    drag = 'open'
  }

  function onMove(e: TouchEvent): void {
    if (drag !== 'open' && drag !== 'x') return
    if (e.touches.length !== 1) {
      if (drag === 'x') settle(false)
      drag = 'off'
      return
    }
    const f = e.touches[0]
    const mx = f.clientX - x0
    const my = f.clientY - y0
    if (drag === 'open') {
      if (Math.max(Math.abs(mx), Math.abs(my)) < SLOP) return
      // A move the browser has begun to scroll can no longer be held.
      const mine = e.cancelable && !e.defaultPrevented && mx > 0 && mx > Math.abs(my) * 1.2 && !scrollsLeft(e.target, root)
      drag = mine ? 'x' : 'off'
      if (!mine) return
      w = root.getBoundingClientRect().width || window.innerWidth || 1
      root.classList.add('is-swiping')
    }
    if (e.cancelable) e.preventDefault()
    dx = Math.max(0, mx)
    track.push({ t: now(), x: f.clientX })
    paint()
  }

  function onEnd(e: TouchEvent): void {
    if (e.touches.length) return
    const was = drag
    drag = 'none'
    if (was !== 'x') return
    // A swipe is no tap.
    if (e.cancelable) e.preventDefault()
    const v = speed()
    settle(dx >= MIN || (dx > 0 && v >= FLICK))
  }

  function onCancel(): void {
    if (drag === 'x') settle(false)
    drag = 'none'
  }

  // The moves are held from the start, as touchscroll.ts says why.
  root.addEventListener('touchstart', onStart, { passive: true })
  root.addEventListener('touchmove', onMove, { passive: false })
  root.addEventListener('touchend', onEnd, { passive: false })
  root.addEventListener('touchcancel', onCancel)
  root.addEventListener('transitionend', onSlid)
  return () => {
    if (slide) clearTimeout(slide.timer)
    slide = null
    drag = 'none'
    clear()
    root.removeEventListener('touchstart', onStart)
    root.removeEventListener('touchmove', onMove)
    root.removeEventListener('touchend', onEnd)
    root.removeEventListener('touchcancel', onCancel)
    root.removeEventListener('transitionend', onSlid)
  }
}
