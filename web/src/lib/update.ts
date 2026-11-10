// A new build of the hub (spec §3 #182). An app on a phone's home screen comes
// back from memory for days instead of loading the page again, so it can run
// an old build long after the service was swapped. index.html is never cached
// and the service worker serves no pages, so a page that loads is the build
// the hub runs at that moment: the first version the hub tells it is its own.
// Each overview after a reconnect says the version the hub runs now. When they
// differ, the page reloads at a moment that loses nothing and surprises no
// one: as it goes off screen or comes back, or on a PC screen left alone in
// another window, and only with nothing open over it, no form being filled
// and no change on its way. The composer keeps its words as a draft (#181).
// Until then a dot on 설정 and a card there say a new build is ready.
import { effect, signal, untracked } from '@preact/signals'
import { writesInFlight } from './api'
import { versionText } from './format'
import { hello } from './hello'
import { route } from './router'
import { host } from './store'
import { toast } from './toast'

/** The version the hub runs when it is not this page's build; null else. */
export const newBuild = signal<string | null>(null)

/** Once a build was reloaded for, not again for a while: a reload that came back on the old page would go round. */
export const RETRY = 10 * 60_000
/** A PC screen on in another window and not touched for this long is as good as away. */
export const AWAY = 60_000
/** How long after a reload its note still belongs to it. */
const FRESH = 60_000
const KEY = 'mori.reload'

/** This page's build: the first version the hub said. */
let mine: string | null = null
let reload = () => location.reload()

interface Tried {
  v: string
  t: number
  told?: boolean
}

function tried(): Tried | null {
  try {
    const t = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as Tried | null
    return t && typeof t.v === 'string' && typeof t.t === 'number' ? t : null
  } catch {
    return null
  }
}

function remember(t: Tried): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(t))
  } catch {
    // no guard this visit
  }
}

/** Whether a reload now loses nothing: nothing open over the page, no form
 *  being filled and no change on its way. A terminal and its composer keep
 *  nothing a reload loses. */
export function safeToReload(): boolean {
  const r = route.value.name
  if (r === 'new' || r === 'settings') return false
  if (writesInFlight() > 0 || document.querySelector('dialog[open]')) return false
  const f = document.activeElement
  const typing = f instanceof HTMLElement && f.matches('input, textarea, select, [contenteditable]') && !f.closest('.xterm, [data-draft]')
  return !typing
}

/** Loads the page again, now. */
export function reloadPage(): void {
  reload()
}

export interface UpdateOptions {
  reload?: () => void
  now?: () => number
}

/** Watches the hub's version and reloads when it is safe; the returned function stops it. */
export function startUpdates(o: UpdateOptions = {}): () => void {
  if (o.reload) reload = o.reload
  const now = o.now ?? Date.now
  let touched = now()
  const touch = () => {
    touched = now()
  }
  const away = () => document.visibilityState === 'visible' && !document.hasFocus() && now() - touched >= AWAY
  const attempt = () => {
    const v = newBuild.value
    if (!v || !safeToReload()) return
    const t = tried()
    if (t && t.v === v && now() - t.t < RETRY) return
    remember({ v, t: now() })
    reload()
  }
  // Off screen, or on its way back.
  const onVisibility = () => attempt()
  const kinds = ['pointerdown', 'keydown', 'wheel'] as const
  for (const k of kinds) window.addEventListener(k, touch, { capture: true, passive: true })
  document.addEventListener('visibilitychange', onVisibility)
  const watch = effect(() => {
    const v = host.value?.version || hello.value?.version
    if (!v) return
    if (mine === null) {
      mine = v
      untracked(() => greet(v, now()))
    } else {
      newBuild.value = v === mine ? null : v
    }
  })
  const wait = effect(() => {
    if (!newBuild.value) return
    untracked(() => {
      if (document.visibilityState === 'hidden') attempt()
    })
    const idle = setInterval(() => {
      if (away()) attempt()
    }, 15_000)
    return () => clearInterval(idle)
  })
  return () => {
    watch()
    wait()
    document.removeEventListener('visibilitychange', onVisibility)
    for (const k of kinds) window.removeEventListener(k, touch, { capture: true })
  }
}

/** After a reload for a new build, says once that the page now runs it. */
function greet(v: string, now: number): void {
  const t = tried()
  if (!t || t.told || t.v !== v || now - t.t > FRESH) return
  remember({ ...t, told: true })
  toast(`새 버전으로 바꿨습니다 · ${versionText(v)}`)
}

/** Forgets this page's build, for tests. */
export function resetUpdates(): void {
  mine = null
  newBuild.value = null
  reload = () => location.reload()
}
