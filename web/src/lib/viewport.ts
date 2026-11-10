// iOS Safari ignores interactive-widget=resizes-content: the on-screen
// keyboard covers the page instead of shrinking it. Following the visual
// viewport keeps the send box and quick keys above the keyboard.
//
// While the keyboard is up the root has the class kb, and the terminal's
// header takes less room (spec §3 #187). A keyboard is a field with the
// focus and a viewport well under the tallest it has been at that width:
// a browser's bars that come and go take less than that.

/** A keyboard takes more than this; the bars of a browser less. */
const KEYBOARD = 120
/** The keyboard slides out after the focus leaves, or goes to another field. */
const SETTLE = 350

const NOT_TYPED = new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'])

/** Whether a phone shows its keyboard for el. */
export function editable(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  if (el.isContentEditable || el instanceof HTMLTextAreaElement) return true
  return el instanceof HTMLInputElement && !NOT_TYPED.has(el.type)
}

export function trackViewport(): () => void {
  const vv = window.visualViewport
  if (!vv) return () => {}
  const root = document.documentElement
  const tallest = new Map<number, number>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const update = () => {
    if (vv.scale > 1.01) return // pinch zoom, not a keyboard
    const w = Math.round(vv.width)
    const top = Math.max(tallest.get(w) ?? 0, vv.height)
    tallest.set(w, top)
    root.style.setProperty('--app-h', `${Math.round(vv.height)}px`)
    root.classList.toggle('kb', top - vv.height > KEYBOARD && editable(document.activeElement))
    if (window.scrollY !== 0) window.scrollTo(0, 0)
  }
  const later = () => {
    clearTimeout(timer)
    timer = setTimeout(update, SETTLE)
  }
  update()
  vv.addEventListener('resize', update)
  vv.addEventListener('scroll', update)
  document.addEventListener('focusin', update)
  document.addEventListener('focusout', later)
  return () => {
    clearTimeout(timer)
    vv.removeEventListener('resize', update)
    vv.removeEventListener('scroll', update)
    document.removeEventListener('focusin', update)
    document.removeEventListener('focusout', later)
    root.style.removeProperty('--app-h')
    root.classList.remove('kb')
  }
}
