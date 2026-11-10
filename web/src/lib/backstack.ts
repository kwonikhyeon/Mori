// The back key and the back gesture close what is open on top first (spec
// §3 #199): a menu, a sheet, a confirm. Where the browser has CloseWatcher
// (Chrome, Android) a modal <dialog> already answers them with its cancel
// event, and a menu asks for a watcher of its own. Elsewhere (iOS) one
// history entry stands for all that is open: Back takes it and closes the
// top one, and the last one closed another way takes the entry back. The
// router writes its own entries after that step, so the two do not cross.

interface Watcher {
  onclose: ((e: Event) => void) | null
  destroy(): void
}
type WatcherCtor = new () => Watcher

interface Layer {
  close: () => void
  closed: boolean
}

const MARK = 'moriLayer'
/** How long a step back may take before the page stops waiting for it, in ms. */
const SETTLE = 600

/** The layers open on the history path, the top one last. */
const stack: Layer[] = []
/** The layers open on either path. */
let count = 0
/** The steps back on their way. */
let pending = 0
let timer: ReturnType<typeof setTimeout> | undefined
let waiting: (() => void)[] = []

function watcherCtor(): WatcherCtor | null {
  const w = (globalThis as { CloseWatcher?: unknown }).CloseWatcher
  return typeof w === 'function' ? (w as WatcherCtor) : null
}

/** Whether a history state is the layers' entry. */
export function marked(state: unknown): boolean {
  return typeof state === 'object' && state !== null && (state as Record<string, unknown>)[MARK] === 1
}

/** state without the layers' mark. */
export function unmarked(state: unknown): unknown {
  if (!marked(state)) return state
  const rest = { ...(state as Record<string, unknown>) }
  delete rest[MARK]
  return Object.keys(rest).length ? rest : null
}

/** Whether a menu, a sheet or a confirm is open. */
export const layersOpen = (): boolean => count > 0

function settle() {
  pending = 0
  clearTimeout(timer)
  timer = undefined
  const fs = waiting
  waiting = []
  for (const f of fs) f()
}

/** Steps back over the layers' entry; what waits for history runs once the step is done. */
function stepBack() {
  pending++
  clearTimeout(timer)
  timer = setTimeout(settle, SETTLE)
  history.back()
}

function afterHistory(f: () => void) {
  if (pending) waiting.push(f)
  else f()
}

/** Gives the open layers their entry, on top of the screen's own. */
function mark() {
  if (!stack.length || marked(history.state)) return
  const s = history.state
  history.pushState({ ...(typeof s === 'object' && s ? s : {}), [MARK]: 1 }, '')
}

/**
 * Opens a layer: while it is open the back key closes it by calling close.
 * dialog says it is a modal <dialog>, which a browser with CloseWatcher
 * closes on its own. The returned function is for when it closes another
 * way, or goes.
 */
export function openLayer(close: () => void, dialog: boolean): () => void {
  count++
  const W = watcherCtor()
  if (W) {
    let done = false
    const w = dialog ? null : new W()
    if (w)
      w.onclose = () => {
        if (done) return
        done = true
        count--
        close()
      }
    return () => {
      if (done) return
      done = true
      count--
      w?.destroy()
    }
  }
  const l: Layer = { close, closed: false }
  stack.push(l)
  afterHistory(() => {
    if (!l.closed) mark()
  })
  return () => {
    if (l.closed) return
    l.closed = true
    count--
    stack.splice(stack.indexOf(l), 1)
    // The entry goes with the last one, unless the page went on from it.
    if (!stack.length)
      afterHistory(() => {
        if (!stack.length && marked(history.state)) stepBack()
      })
  }
}

/**
 * Runs the router's history write: at once, or, while the layers' entry is
 * the current one, after the step back over it, so the new screen's entry
 * neither lands on top of it nor goes with it. Layers still open get an
 * entry again on top.
 */
export function writeHistory(f: () => void): void {
  if (!pending && marked(history.state)) stepBack()
  afterHistory(() => {
    f()
    mark()
  })
}

function onPop() {
  if (pending) {
    if (--pending === 0) settle()
    return
  }
  if (stack.length && !marked(history.state)) {
    const l = stack.pop()!
    l.closed = true
    count--
    l.close()
    mark() // the ones under it keep an entry
    return
  }
  // Forward onto the entry of layers closed while the page went on.
  if (!stack.length && marked(history.state)) stepBack()
}

/** Drops a mark a reload left and follows the back key; the returned function stops it. */
export function initBackstack(): () => void {
  if (marked(history.state)) history.replaceState(unmarked(history.state), '')
  window.addEventListener('popstate', onPop)
  return () => window.removeEventListener('popstate', onPop)
}

/** Forgets every layer and step; for tests. */
export function resetBackstack(): void {
  stack.length = 0
  count = 0
  pending = 0
  clearTimeout(timer)
  timer = undefined
  waiting = []
}
