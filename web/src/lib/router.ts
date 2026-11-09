// The screens as hash routes (spec §3 #121). Every segment is one
// encodeURIComponent, so an address like machine/t7 keeps its slash inside;
// the rest goes in a query.
import { signal } from '@preact/signals'

export type Route =
  | { name: 'queue' }
  | { name: 'folders' }
  | { name: 'settings' }
  | { name: 'new'; folder?: string; wt?: string }
  | { name: 'terminal'; addr: string; git: boolean }
  | { name: 'git'; folder: string; path?: string }
  | { name: 'graph'; folder: string; path?: string; head: boolean; c?: string }

const QUEUE: Route = { name: 'queue' }

function qs(params: Record<string, string | undefined>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v)
  const s = p.toString()
  return s ? '?' + s : ''
}

export function href(r: Route): string {
  const seg = encodeURIComponent
  switch (r.name) {
    case 'queue': return '#/'
    case 'folders': return '#/folders'
    case 'settings': return '#/settings'
    case 'new': return '#/new' + qs({ folder: r.folder, wt: r.wt })
    case 'terminal': return `#/t/${seg(r.addr)}` + (r.git ? '/git' : '')
    case 'git': return `#/git/${seg(r.folder)}` + qs({ path: r.path })
    case 'graph': return `#/graph/${seg(r.folder)}` + qs({ path: r.path, head: r.head ? '1' : undefined, c: r.c })
  }
}

/** The route of a hash; anything it does not know is the queue. */
export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '')
  const q = raw.indexOf('?')
  const path = (q < 0 ? raw : raw.slice(0, q)).replace(/^\/+|\/+$/g, '')
  const p = new URLSearchParams(q < 0 ? '' : raw.slice(q + 1))
  let s: string[]
  try {
    s = path === '' ? [] : path.split('/').map(decodeURIComponent)
  } catch {
    return QUEUE // a broken escape
  }
  if (s.some((x) => x === '')) return QUEUE
  const opt = (k: string) => p.get(k) || undefined
  switch (s[0]) {
    case undefined: return QUEUE
    case 'folders': return s.length === 1 ? { name: 'folders' } : QUEUE
    case 'settings': return s.length === 1 ? { name: 'settings' } : QUEUE
    case 'new': return s.length === 1 ? { name: 'new', folder: opt('folder'), wt: opt('wt') } : QUEUE
    case 't':
      if (s.length === 2) return { name: 'terminal', addr: s[1], git: false }
      if (s.length === 3 && s[2] === 'git') return { name: 'terminal', addr: s[1], git: true }
      return QUEUE
    case 'git': return s.length === 2 ? { name: 'git', folder: s[1], path: opt('path') } : QUEUE
    case 'graph':
      return s.length === 2 ? { name: 'graph', folder: s[1], path: opt('path'), head: p.get('head') === '1', c: opt('c') } : QUEUE
    default: return QUEUE
  }
}

export const route = signal<Route>(QUEUE)

/** A click that opens the link here: the main button, with no key that asks for a new tab or window. */
export function plainClick(e: MouseEvent): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey
}

/** Goes to r; replace leaves no step for the back button. */
export function navigate(r: Route, opts: { replace?: boolean } = {}): void {
  const h = href(r)
  if (opts.replace) history.replaceState(history.state, '', location.pathname + location.search + h)
  else if (location.hash !== h) location.hash = h
  route.value = parseHash(h)
}

/** Follows the hash; the returned function stops it. */
export function initRouter(): () => void {
  const update = () => {
    const next = parseHash(location.hash)
    if (href(next) !== href(route.value)) route.value = next
  }
  route.value = parseHash(location.hash)
  window.addEventListener('hashchange', update)
  return () => window.removeEventListener('hashchange', update)
}
