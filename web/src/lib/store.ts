// What the event stream knows (spec §7.2): every terminal by address, the
// folders and the core. A snapshot replaces all of it, so a reconnect never
// keeps a terminal that ended while the stream was down.
import { batch, signal } from '@preact/signals'
import type { CoreStatus, EventMessage, FolderView, Host, Overview, Preset, TerminalView } from './types'

/** The event stream: connecting until a snapshot, down after two seconds without one. */
export type Conn = 'connecting' | 'open' | 'down' | 'restarting'

export const terminals = signal<Map<string, TerminalView>>(new Map())
export const folders = signal<FolderView[]>([])
export const core = signal<CoreStatus>({ connected: false })
export const conn = signal<Conn>('connecting')
/** A snapshot came: an empty list is really empty. */
export const ready = signal(false)
export const host = signal<Overview['host'] | null>(null)
export const presets = signal<Preset[]>([])
export const hosts = signal<Host[]>([])

export function apply(msg: EventMessage): void {
  switch (msg.type) {
    case 'snapshot':
      batch(() => {
        terminals.value = new Map(msg.terminals.map((t) => [t.address, t]))
        folders.value = msg.folders
        core.value = msg.core
        ready.value = true
      })
      return
    case 'terminal': {
      const next = new Map(terminals.value)
      next.set(msg.terminal.address, msg.terminal)
      terminals.value = next
      return
    }
    case 'removed': {
      if (!terminals.value.has(msg.address)) return
      const next = new Map(terminals.value)
      next.delete(msg.address)
      terminals.value = next
      return
    }
    case 'folders':
      folders.value = msg.folders
      return
    case 'core': {
      const { type: _type, ...status } = msg
      core.value = status
      return
    }
  }
}

/** What only GET /api/overview says: this host, the presets and the other hosts. */
export function applyOverview(o: Overview): void {
  batch(() => {
    host.value = o.host
    presets.value = o.presets
    hosts.value = o.hosts
  })
}

export function resetStore(): void {
  batch(() => {
    terminals.value = new Map()
    folders.value = []
    core.value = { connected: false }
    conn.value = 'connecting'
    ready.value = false
    host.value = null
    presets.value = []
    hosts.value = []
  })
}
