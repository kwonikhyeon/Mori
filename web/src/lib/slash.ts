// The slash commands of a Claude Code terminal, for the list above the
// composer (spec §3 #197). The server reads them from the folder and the
// Claude Code config; this orders them for what is typed after the "/", and
// keeps the ones this device sent lately.

import { load, save } from './storage'
import type { CommandList, SlashCommand, TerminalView } from './types'

/** The ones used all the time: first on an empty or one-letter query, after the recent ones. */
export const COMMON = ['compact', 'clear', 'model', 'resume', 'context']
export const RECENT_MAX = 8
/** How many rows the list shows; the rest it counts. */
export const SHOWN = 80

const RECENT_KEY = 'mori.slashRecent'

/** Whether q starts the name, a part of it after a ":" ("dep" for Kit:deploy), or an alias. */
function starts(c: SlashCommand, q: string): boolean {
  return [c.name, ...(c.aliases ?? [])].some((n) => {
    const parts = n.toLowerCase().split(':')
    return parts.some((_, i) => parts.slice(i).join(':').startsWith(q))
  })
}

/**
 * The commands for q, what follows the "/": the ones q starts first, then
 * the ones with q inside the name, each in the server's order. An empty or
 * one-letter q, what a phone shows right after the "/", puts the ones this
 * device sent lately first, then a few used all the time.
 */
export function rank(list: SlashCommand[], q: string, recent: string[] = []): SlashCommand[] {
  const ql = q.toLowerCase()
  if (ql.length > 1) {
    const a = list.filter((c) => starts(c, ql))
    return [...a, ...list.filter((c) => !a.includes(c) && c.name.toLowerCase().includes(ql))]
  }
  const fits = ql ? list.filter((c) => starts(c, ql)) : list
  const named = new Map<string, SlashCommand>()
  for (const c of fits) {
    for (const n of [c.name, ...(c.aliases ?? [])]) if (!named.has(n)) named.set(n, c)
  }
  const first: SlashCommand[] = []
  for (const n of [...recent, ...COMMON]) {
    const c = named.get(n)
    if (c && !first.includes(c)) first.push(c)
  }
  const rest = ql ? [...fits, ...list.filter((c) => !fits.includes(c) && c.name.toLowerCase().includes(ql))] : list
  return [...first, ...rest.filter((c) => !first.includes(c))]
}

/** The command a sent text names ("/model sonnet" → "model"), or null; a path is not one. */
export function used(text: string): string | null {
  const m = /^\/([^\s/]+)(?:\s|$)/.exec(text.trim())
  return m ? m[1] : null
}

/** The commands this device sent lately, newest first. */
export function recent(): string[] {
  const v = load<unknown>(RECENT_KEY, [])
  return Array.isArray(v) ? v.filter((n): n is string => typeof n === 'string').slice(0, RECENT_MAX) : []
}

/** Remembers the command text names, if it names one. */
export function note(text: string): void {
  const name = used(text)
  if (name) save(RECENT_KEY, [name, ...recent().filter((n) => n !== name)].slice(0, RECENT_MAX))
}

/**
 * What the text before the caret asks for: q, what follows a "/" at the
 * start, and end, where the word under the caret ends. Null when it is not a
 * command being typed.
 */
export function slashAt(text: string, caret: number): { q: string; end: number } | null {
  const m = /^\/(\S*)$/.exec(text.slice(0, caret))
  if (!m) return null
  return { q: m[1], end: caret + (/^\S*/.exec(text.slice(caret))?.[0].length ?? 0) }
}

/** text with the command name in place of the one being typed, and where the caret goes: after "/name ". */
export function insert(text: string, end: number, name: string): { text: string; caret: number } {
  return { text: `/${name} ${text.slice(end).replace(/^\s+/, '')}`, caret: name.length + 2 }
}

const base = (p: string | undefined) =>
  (p ?? '')
    .split(/[\\/]/)
    .pop()!
    .replace(/\.exe$/i, '')
    .toLowerCase()

/** Whether t runs Claude Code: what it reports, else the program's name. */
export function isClaude(t: Pick<TerminalView, 'status' | 'argv' | 'foreground'>): boolean {
  if (t.status?.app === 'claude-code') return true
  const fg = t.foreground
  return [t.argv[0], fg?.name, fg?.argv[0], fg?.argv[1]].some((p) => base(p) === 'claude')
}

// What the server said, kept a minute so each "/" does not ask again; a
// partial list a few seconds, as the server may have read all of it by then.
const LIFE = 60_000
const PARTIAL_LIFE = 5_000
const KEPT_MAX = 50

interface Kept {
  at: number
  list: Promise<CommandList>
  partial: boolean
}

const kept = new Map<string, Kept>()

/** The commands of addr on host; get asks the server when none are kept. */
export function commandsOf(host: string, addr: string, get: () => Promise<CommandList>, now = Date.now()): Promise<CommandList> {
  const key = host + '\u0000' + addr
  const hit = kept.get(key)
  if (hit && now - hit.at < (hit.partial ? PARTIAL_LIFE : LIFE)) return hit.list
  const k: Kept = { at: now, list: get(), partial: false }
  kept.delete(key)
  kept.set(key, k)
  while (kept.size > KEPT_MAX) kept.delete(kept.keys().next().value!)
  k.list.then(
    (l) => {
      k.partial = l.partial
    },
    () => {
      if (kept.get(key) === k) kept.delete(key) // asked again next time
    },
  )
  return k.list
}

/** Forgets every kept list; for tests. */
export function forgetCommands(): void {
  kept.clear()
}
