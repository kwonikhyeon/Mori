// What the box calls back with ↑ and ↓ (claude-input design §5.2): what was
// sent in the terminal's folder, newest first, from Claude Code's record
// through the server, or else what this device sent there. The walk keeps
// what was being written, and comes back to it past the newest.

import { load, save } from './storage'

const MAX = 100
const key = (host: string, addr: string) => `mori.sent.${host}.${addr}`

/** What this device sent to a terminal, newest first. */
export function sentHere(host: string, addr: string): string[] {
  const v = load<unknown>(key(host, addr), [])
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** Keeps a send, newest first: 100 at most, a repeat of the newest once. */
export function rememberSent(host: string, addr: string, text: string): void {
  const now = sentHere(host, addr)
  if (now[0] === text) return
  save(key(host, addr), [text, ...now].slice(0, MAX))
}

/** A walk through what was sent, from the newest back. */
export class Recall {
  private list: string[] | null = null
  private at = -1
  private draft = ''

  constructor(private readonly load: () => Promise<string[]>) {}

  /** Showing a past send rather than what was being written. */
  get browsing(): boolean {
    return this.at >= 0
  }

  /** One send older; null past the oldest. draft is what the box holds when the walk starts. */
  async older(draft: string): Promise<string | null> {
    if (this.list === null) this.list = await this.load()
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

  /** A send went: the list is read again at the next walk. */
  refresh(): void {
    this.list = null
    this.at = -1
  }
}
