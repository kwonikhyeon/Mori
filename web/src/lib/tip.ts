// The page's one tooltip (spec §3 #247), after astryx's Tooltip: a control
// with data-tip shows that text above it, centred, after 200 ms of a mouse on
// it, or at once when the keyboard brings the focus to it. A finger never
// opens it: a tap only acts. Leaving the control (a 100 ms bridge lets the
// pointer onto the tooltip, which stays while it is there), a press, Escape,
// a scroll or the window's size changing hides it. Escape still reaches the
// layer beneath, as astryx's spec AST-003 means an unpinned tooltip to be.
// It sits in the top layer as a manual popover, above a modal too, where
// the browser has popovers.

export const SHOW_MS = 200
export const BRIDGE_MS = 100
/** Room kept from the control and from the window's edges. */
const GAP = 4
const EDGE = 8

/** The attributes of an icon-only control: its name, read out and shown on hover. */
export const tip = (text: string) => ({ 'aria-label': text, 'data-tip': text })

let el: HTMLDivElement | null = null
let on: Element | null = null
let showing: ReturnType<typeof setTimeout> | undefined
let hiding: ReturnType<typeof setTimeout> | undefined

const target = (e: Event) => (e.target instanceof Element ? e.target.closest<HTMLElement>('[data-tip]') : null)

function show(t: HTMLElement): void {
  clearTimeout(showing)
  clearTimeout(hiding)
  const text = t.dataset.tip
  if (!el || !text || !t.isConnected) return
  on = t
  el.textContent = text
  el.hidden = false
  if (el.popover && !el.matches(':popover-open')) el.showPopover()
  // Above, centred; below when there is no room above; inside the window either way.
  const r = t.getBoundingClientRect()
  const w = el.offsetWidth
  const h = el.offsetHeight
  const left = Math.min(Math.max(EDGE, r.left + r.width / 2 - w / 2), window.innerWidth - EDGE - w)
  const top = r.top - GAP - h >= EDGE ? r.top - GAP - h : r.bottom + GAP
  el.style.left = `${Math.round(left)}px`
  el.style.top = `${Math.round(top)}px`
}

export function hideTip(): void {
  clearTimeout(showing)
  clearTimeout(hiding)
  on = null
  if (!el || el.hidden) return
  if (el.popover && el.matches(':popover-open')) el.hidePopover()
  el.hidden = true
}

function later(t: HTMLElement): void {
  clearTimeout(hiding)
  if (on === t) return
  clearTimeout(showing)
  showing = setTimeout(() => show(t), SHOW_MS)
}

function bridge(): void {
  clearTimeout(showing)
  clearTimeout(hiding)
  hiding = setTimeout(hideTip, BRIDGE_MS)
}

/** Draws the tooltip and listens on the document. The returned function stops it. */
export function initTips(): () => void {
  el = document.createElement('div')
  el.className = 'tip'
  el.setAttribute('role', 'tooltip')
  el.hidden = true
  if ('popover' in el) el.popover = 'manual'
  document.body.append(el)
  const tipEl = el

  const over = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return
    if (tipEl.contains(e.target as Node)) return void clearTimeout(hiding)
    const t = target(e)
    if (t) later(t)
  }
  const out = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return
    const from = tipEl.contains(e.target as Node) ? tipEl : target(e)
    // Moving inside the control or the tooltip is not leaving it.
    if (from && !from.contains(e.relatedTarget as Node | null)) bridge()
  }
  const focus = (e: FocusEvent) => {
    const t = target(e)
    if (t && focusVisible(t)) show(t)
  }
  const blur = (e: FocusEvent) => {
    if (target(e) === on) hideTip()
  }
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !e.isComposing) hideTip()
  }
  const opts = { capture: true, passive: true }
  document.addEventListener('pointerover', over, opts)
  document.addEventListener('pointerout', out, opts)
  document.addEventListener('pointerdown', hideTip, opts)
  document.addEventListener('focusin', focus, opts)
  document.addEventListener('focusout', blur, opts)
  document.addEventListener('keydown', key, opts)
  document.addEventListener('scroll', hideTip, opts)
  window.addEventListener('resize', hideTip, opts)
  return () => {
    hideTip()
    document.removeEventListener('pointerover', over, opts)
    document.removeEventListener('pointerout', out, opts)
    document.removeEventListener('pointerdown', hideTip, opts)
    document.removeEventListener('focusin', focus, opts)
    document.removeEventListener('focusout', blur, opts)
    document.removeEventListener('keydown', key, opts)
    document.removeEventListener('scroll', hideTip, opts)
    window.removeEventListener('resize', hideTip, opts)
    tipEl.remove()
    el = null
  }
}

/** Keyboard focus, not the focus a click or a tap leaves behind. */
function focusVisible(t: Element): boolean {
  try {
    return t.matches(':focus-visible')
  } catch {
    return false
  }
}
