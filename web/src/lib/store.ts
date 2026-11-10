// What the event stream knows (spec §7.2): every terminal by address, the
// folders and the core. A snapshot replaces all of it, so a reconnect never
// keeps a terminal that ended while the stream was down. Every host has its
// own (spec §3 #170); which hosts are linked is the hub's alone to say.
import { batch, signal, type Signal } from '@preact/signals'
import type { CoreStatus, EventMessage, FolderView, Host, Overview, Preset, TerminalView } from './types'

/** The event stream: connecting until a snapshot, down after two seconds without one. */
export type Conn = 'connecting' | 'open' | 'down' | 'restarting'

/** What one host's event stream and overview say. */
export interface HostStore {
  terminals: Signal<Map<string, TerminalView>>
  folders: Signal<FolderView[]>
  core: Signal<CoreStatus>
  conn: Signal<Conn>
  /** A snapshot came: an empty list is really empty. */
  ready: Signal<boolean>
  host: Signal<Overview['host'] | null>
  presets: Signal<Preset[]>
  apply(msg: EventMessage): void
  /** What only GET /api/overview says: the host and its presets. */
  applyOverview(o: Overview): void
  reset(): void
}

/** A store of its own; its overview's list of hosts is not its to keep. */
export function makeStore(): HostStore {
  const terminals = signal<Map<string, TerminalView>>(new Map())
  const folders = signal<FolderView[]>([])
  const core = signal<CoreStatus>({ connected: false })
  const conn = signal<Conn>('connecting')
  const ready = signal(false)
  const host = signal<Overview['host'] | null>(null)
  const presets = signal<Preset[]>([])

  function apply(msg: EventMessage): void {
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

  function applyOverview(o: Overview): void {
    batch(() => {
      host.value = o.host
      presets.value = o.presets
    })
  }

  function reset(): void {
    batch(() => {
      terminals.value = new Map()
      folders.value = []
      core.value = { connected: false }
      conn.value = 'connecting'
      ready.value = false
      host.value = null
      presets.value = []
    })
  }

  return { terminals, folders, core, conn, ready, host, presets, apply, applyOverview, reset }
}

/** The hosts linked to this hub (spec §7.1 hosts), from its overview. */
export const hosts = signal<Host[]>([])
/** The hub said which hosts it has: an empty list is really empty. */
export const hostsReady = signal(false)

const own = makeStore()

/** The hub's store: the page's own server, which also says which hosts are linked. */
export const hubStore: HostStore = {
  ...own,
  applyOverview(o) {
    batch(() => {
      own.applyOverview(o)
      hosts.value = o.hosts
      hostsReady.value = true
    })
  },
  reset() {
    batch(() => {
      own.reset()
      hosts.value = []
      hostsReady.value = false
    })
  },
}

export const { terminals, folders, core, conn, ready, host, presets } = hubStore
export const apply = hubStore.apply
export const applyOverview = hubStore.applyOverview
export const resetStore = hubStore.reset
