// A region's actions at the pointer (astryx ContextMenu, spec §3 #242): a
// right-click on it, or Shift+F10 and the menu key on what has the focus,
// opens the list Menu draws. A mouse opens it at the cursor, a key under
// the focused element; it stays inside the window. A press elsewhere, the
// wheel, a resize or the window losing the focus close it. Shift with the
// right-click keeps the browser's own menu, and so does a touch: astryx's
// long-press sheet is not here.
import { signal } from '@preact/signals'
import { useEffect, useId, useLayoutEffect, useRef } from 'preact/hooks'
import { MenuList, type MenuItem } from './Menu'

interface Shown {
  x: number
  y: number
  label: string
  items: MenuItem[]
  /** Where the focus was, to go back to. */
  back: HTMLElement | null
  /** Tells one opening from the next, so a menu opened again starts afresh. */
  n: number
}

const shown = signal<Shown | null>(null)
let opened = 0

/**
 * The contextmenu handler of a region named label: items gives its actions
 * for the event (the row under the pointer, say), none leaving the
 * browser's menu. The innermost region with items wins.
 */
export function onContext(label: string, items: (e: MouseEvent) => MenuItem[]) {
  return (e: MouseEvent) => {
    if (e.shiftKey || e.defaultPrevented || (e as PointerEvent).pointerType === 'touch') return
    const list = items(e)
    if (list.length === 0) return
    e.preventDefault()
    // A key fires it with button 0, on the element with the focus.
    const r = (e.target as Element).getBoundingClientRect()
    const at = e.button === 2 ? { x: e.clientX, y: e.clientY } : { x: r.left, y: r.bottom }
    shown.value = { ...at, label, items: list, back: document.activeElement as HTMLElement | null, n: ++opened }
  }
}

/** Closes the menu, as a test or a screen that goes away would. */
export function closeContext() {
  shown.value = null
}

/** The one context menu of the page; App draws it once. */
export function ContextMenuHost() {
  const s = shown.value
  return s ? <Open key={s.n} s={s} /> : null
}

function Open({ s }: { s: Shown }) {
  const id = useId()
  const list = useRef<HTMLDivElement>(null)

  // Placed before it is painted, on the element: drawn hidden first, it could not take the focus.
  // It flips to the other side of the point where it would leave the window.
  useLayoutEffect(() => {
    const el = list.current
    if (!el) return
    const m = parseFloat(getComputedStyle(el).getPropertyValue('--ctx-margin')) || 0
    const { width, height } = el.getBoundingClientRect()
    const fit = (p: number, size: number, room: number) => Math.max(m, p + size + m > room ? Math.min(p - size, room - size - m) : p)
    el.style.left = `${fit(s.x, width, window.innerWidth)}px`
    el.style.top = `${fit(s.y, height, window.innerHeight)}px`
  }, [])

  const close = (back: boolean) => {
    if (shown.value?.n === s.n) shown.value = null
    if (back) s.back?.focus()
  }

  useEffect(() => {
    const away = (e: Event) => {
      if (!list.current?.contains(e.target as Node)) close(false)
    }
    const gone = () => close(false)
    document.addEventListener('pointerdown', away, true)
    document.addEventListener('wheel', away, { capture: true, passive: true })
    window.addEventListener('resize', gone)
    window.addEventListener('blur', gone)
    return () => {
      document.removeEventListener('pointerdown', away, true)
      document.removeEventListener('wheel', away, true)
      window.removeEventListener('resize', gone)
      window.removeEventListener('blur', gone)
    }
  }, [])

  return (
    <MenuList
      id={id}
      label={s.label}
      items={s.items}
      start="first"
      onClose={close}
      listRef={list}
      class="menu-list ctx-menu"
      style={{ left: `${s.x}px`, top: `${s.y}px` }}
    />
  )
}
