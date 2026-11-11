// Words for a screen reader, spoken as astryx's useAnnounce speaks them
// (spec §3 #203). Two live regions, one polite (role=status) and one
// assertive (role=alert), are made empty and stay: many screen readers do not
// read a region made with its words, but do read a change in an empty one. A
// modal dialog makes the page behind it inert, so while one is open the words
// go to regions of its own. A write empties the region and sets the words a
// frame later, so the same words twice are read twice; they leave 2 s on,
// so no stale words stay behind.

export type Politeness = 'polite' | 'assertive'

const ATTR = 'data-mori-live'
const CLEAR_MS = 2_000

interface Waiting {
  words: string[]
  frame: number | null
  clear: number | null
}

const waiting = new WeakMap<HTMLElement, Waiting>()

/** The open modal dialog on top, else the page. */
function host(): HTMLElement {
  return [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].reverse().find((d) => d.matches(':modal')) ?? document.body
}

/** The host's region for one urgency, made empty on first use. */
function region(at: HTMLElement, politeness: Politeness): HTMLElement {
  let el = at.querySelector<HTMLElement>(`:scope > [${ATTR}="${politeness}"]`)
  if (!el) {
    el = document.createElement('div')
    el.className = 'sr-only'
    el.setAttribute(ATTR, politeness)
    el.setAttribute('role', politeness === 'assertive' ? 'alert' : 'status')
    el.setAttribute('aria-live', politeness)
    el.setAttribute('aria-atomic', 'true')
    at.appendChild(el)
  }
  return el
}

/** Makes the page's regions at start, so the first words find them there. */
export function initAnnounce(): void {
  region(document.body, 'polite')
  region(document.body, 'assertive')
}

/** Speaks `text`: an error at once ('assertive'), anything else when idle. */
export function announce(text: string, politeness: Politeness = 'polite'): void {
  const el = region(host(), politeness)
  let w = waiting.get(el)
  if (!w) waiting.set(el, (w = { words: [], frame: null, clear: null }))
  const words = w
  // Words written in one frame are read together, each once.
  if (!words.words.includes(text)) words.words.push(text)
  if (words.frame === null) {
    el.textContent = ''
    words.frame = requestAnimationFrame(() => {
      words.frame = null
      el.textContent = words.words.join(' ')
      words.words = []
    })
  }
  if (words.clear !== null) clearTimeout(words.clear)
  words.clear = window.setTimeout(() => {
    words.clear = null
    el.textContent = ''
  }, CLEAR_MS)
}
