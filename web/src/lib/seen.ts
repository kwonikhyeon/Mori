// Finishes this device has not opened yet (spec §3 #190). A turn ends when
// the program leaves working (hc's turn goes up) and it waits for input, the
// same change that sends 입력 대기 (spec §6.5). Its row has a dot until
// the session is open here while a person looks at the page.
import { signal } from '@preact/signals'
import { stateKind } from './format'
import { load, save } from './storage'
import type { TerminalView } from './types'

const KEY = 'mori.seen'
/** A finish older than this is no news. */
const RECENT = 24 * 3_600_000
/** How long a mark is kept. */
const KEEP = 7 * 24 * 3_600_000

interface Mark {
  /** created_ms: an address hc gives out again is another session. */
  c: number
  turn: number
  /** When it was marked, to forget old marks. */
  at: number
}

type Marks = Record<string, Mark>

const isMark = (v: unknown): v is Mark => {
  const m = v as Mark | null
  return !!m && typeof m === 'object' && typeof m.c === 'number' && typeof m.turn === 'number' && typeof m.at === 'number'
}

function read(): Marks {
  const raw = load<unknown>(KEY, null)
  const out: Marks = {}
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) if (isMark(v)) out[k] = v
  }
  return out
}

export const seenMarks = signal<Marks>(read())

/** host is the scope's ID, '' for the hub. */
const keyOf = (host: string, addr: string) => `${host}|${addr}`

const covers = (m: Mark | undefined, t: TerminalView) => !!m && m.c === t.created_ms && m.turn >= t.turn

/** The session as it is now has been seen on this device. */
export function markSeen(host: string, t: TerminalView, at = Date.now()): void {
  const k = keyOf(host, t.address)
  const marks = seenMarks.peek()
  if (covers(marks[k], t)) return
  const next: Marks = {}
  for (const [key, m] of Object.entries(marks)) if (at - m.at < KEEP) next[key] = m
  next[k] = { c: t.created_ms, turn: t.turn, at }
  seenMarks.value = next
  save(KEY, next)
}

/** A turn of t ended in the last day and waits for input, and this device has not opened it since. */
export function unseen(host: string, t: TerminalView, now: number): boolean {
  if (t.turn === 0 || t.status_ms == null || stateKind(t) !== 'waiting') return false
  if (now - t.status_ms > RECENT) return false
  return !covers(seenMarks.value[keyOf(host, t.address)], t)
}

/** Reads this device's marks again, for tests. */
export function resetSeen(): void {
  seenMarks.value = read()
}
