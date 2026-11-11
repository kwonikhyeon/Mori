// What the box calls back with ↑ and ↓ (claude-input design §5.2): what was
// sent in the terminal's folder, newest first, from Claude Code's record
// through the server, or else what this device sent there. The walk keeps
// what was being written, and comes back to it past the newest. What this
// device keeps is a Claude Code terminal's only, under its host, address
// and start, for 30 days.

import { load, save } from './storage'

const MAX = 100
const PREFIX = 'mori.sent.'
const KEEP_MS = 30 * 24 * 3600 * 1000
// what was sent this visit and may not be in Claude Code's record yet
const PENDING = 20

interface Sent {
  text: string
  at: number
}

const isSent = (x: unknown): x is Sent =>
  !!x && typeof x === 'object' && typeof (x as Sent).text === 'string' && typeof (x as Sent).at === 'number'

function read(key: string): Sent[] {
  const v = load<unknown>(PREFIX + key, [])
  return Array.isArray(v) ? v.filter(isSent) : []
}

/** What this device sent to a terminal (key: host.address.start), newest first, the last 30 days. */
export function sentHere(key: string): string[] {
  const now = Date.now()
  return read(key)
    .filter((s) => now - s.at < KEEP_MS)
    .map((s) => s.text)
}

/** Drops what is 30 days old, the terminals gone that long with it. */
function prune(now: number): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      if (!k?.startsWith(PREFIX)) continue
      const kept = read(k.slice(PREFIX.length))
      if (!kept.length || now - kept[0].at >= KEEP_MS) localStorage.removeItem(k)
    }
  } catch {
    // storage that cannot be read keeps nothing anyway
  }
}

/** Keeps a send, newest first: 100 at most, a repeat of the newest once. */
export function rememberSent(key: string, text: string): void {
  const now = Date.now()
  const kept = read(key).filter((s) => now - s.at < KEEP_MS)
  if (kept[0]?.text !== text) save(PREFIX + key, [{ text, at: now }, ...kept].slice(0, MAX))
  prune(now)
}

/** The record with what was just sent in front, where it is not there yet. */
function merge(pending: string[], record: string[]): string[] {
  let out = record
  for (const p of [...pending].reverse()) if (!out.slice(0, pending.length + 1).includes(p)) out = [p, ...out]
  return out
}

/** A walk through what was sent, from the newest back. */
export class Recall {
  private list: string[] | null = null
  private at = -1
  private draft = ''
  private pending: string[] = []

  constructor(private readonly load: () => Promise<string[]>) {}

  /** Showing a past send rather than what was being written. */
  get browsing(): boolean {
    return this.at >= 0
  }

  /** One send older; null past the oldest. draft is what the box holds when the walk starts. */
  async older(draft: string): Promise<string | null> {
    if (this.list === null) this.list = merge(this.pending, await this.load())
    if (this.at < 0) this.draft = draft
    if (this.at + 1 >= this.list.length) return null
    this.at++
    return this.list[this.at]
  }

  /** One send newer, and past the newest what was being written; null while not walking. */
  newer(): string | null {
    if (this.at < 0 || !this.list) return null
    this.at--
    return this.at < 0 ? this.draft : this.list[this.at]
  }

  /** The walk is over: an edit made the shown send the one being written. */
  reset(): void {
    this.at = -1
  }

  /** A send went: it comes first, though the record may not have it yet. */
  sent(text: string): void {
    if (this.pending[0] !== text) this.pending = [text, ...this.pending].slice(0, PENDING)
  }

  /** A send went: the list is read again at the next walk. */
  refresh(): void {
    this.list = null
    this.at = -1
  }
}
