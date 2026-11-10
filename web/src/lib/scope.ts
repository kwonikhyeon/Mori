// Every host the page shows (spec §3 #170): the hub it came from, and each
// host linked to that hub, reached through the hub's /h/<ID>. A scope is one
// host's state, its calls and its screens' addresses; a screen reads the
// scope it is in with useHost().
import { batch, computed, effect, signal, untracked, type ReadonlySignal, type Signal } from '@preact/signals'
import { createContext } from 'preact'
import { useContext } from 'preact/hooks'
import { api, ApiError, apiFor, hostPrefix, hubUnpaired, wsURL, type HostApi } from './api'
import { Backoff } from './backoff'
import { now } from './clock'
import { EventStream, type SocketCtor } from './events'
import { hostLabel } from './hello'
import { isHere } from './hosts'
import { groupQueue, needsCount, type GroupKey } from './queue'
import { href, navigate, type Page } from './router'
import { hosts, hostsReady, hubStore, makeStore, type HostStore } from './store'
import type { Host, Hello } from './types'
import { onWake } from './wake'

/** Why the page cannot show a host as it is now: the hub lost its link, or cannot reach it. */
export type Problem = 'unlinked' | 'unreachable' | null

export interface HostScope extends HostStore {
  /** The host's ID; '' is the hub. */
  id: string
  api: HostApi
  /** The WebSocket address of path on this host. */
  ws(path: string): string
  name: ReadonlySignal<string>
  /** The hub could not reach the host the last time it asked. */
  unreachable: Signal<boolean>
  problem: ReadonlySignal<Problem>
  /** The sessions in each group of the queue; none while there is a problem. */
  counts: ReadonlySignal<Record<GroupKey, number>>
  /** What waits for a person: 승인 대기, 오류 and 입력 대기; none while there is a problem. */
  needs: ReadonlySignal<number>
  href(r: Page): string
  go(r: Page, o?: { replace?: boolean }): void
  /** A 4401 closed the host's stream: says whether to open it again. */
  unauthorized(): Promise<boolean>
  /** Tries the host again now. */
  retry(): void
}

// What the hub says when it closes a relayed socket (spec §7.2).
const NO_SUCH_HOST = 4404
const OUT_OF_REACH = 4502

const NONE: Record<GroupKey, number> = { blocked: 0, error: 0, waiting: 0, working: 0, none: 0, finished: 0 }

function tally(store: HostStore, problem: ReadonlySignal<Problem>) {
  const groups = computed(() => (problem.value ? null : groupQueue(store.terminals.value.values(), now.value)))
  const counts = computed(() => {
    const gs = groups.value
    if (!gs) return NONE
    const c = { ...NONE }
    for (const g of gs) c[g.key] = g.items.length
    return c
  })
  const needs = computed(() => (groups.value ? needsCount(groups.value) : 0))
  return { counts, needs }
}

const noProblem = computed<Problem>(() => null)

/** The page's own server. Its screens are at the hash's top: #/, #/t/…. */
export const hub: HostScope = {
  ...hubStore,
  id: '',
  api,
  ws: (p) => wsURL(p),
  name: hostLabel,
  unreachable: signal(false),
  problem: noProblem,
  ...tally(hubStore, noProblem),
  href: (r) => href({ ...r, host: undefined }),
  go: (r, o) => navigate({ ...r, host: undefined }, o),
  unauthorized: async () => {
    hubUnpaired()
    return false
  },
  retry: () => {},
}

/** The running stream of each linked host, by ID; startHosts keeps it. */
interface Run {
  stream: EventStream
  /** The wait before opening the stream again after a 4401. */
  restart: Backoff
  timer?: ReturnType<typeof setTimeout>
}
const runs = new Map<string, Run>()

/** The scope of a host linked to the hub. Its screens are under #/h/<ID>. */
export function makeScope(id: string): HostScope {
  const store = makeStore()
  const unreachable = signal(false)
  const listed = computed(() => hosts.value.find((h) => h.id === id))
  const problem = computed<Problem>(() => (listed.value?.linked === false ? 'unlinked' : unreachable.value ? 'unreachable' : null))
  const hostApi = apiFor(hostPrefix(id), (kind) => {
    if (kind === 'host_unlinked') void reloadHosts()
    else unreachable.value = true
  })
  return {
    ...store,
    id,
    api: hostApi,
    ws: (p) => wsURL(hostPrefix(id) + p),
    name: computed(() => listed.value?.name ?? id),
    unreachable,
    problem,
    ...tally(store, problem),
    href: (r) => href({ ...r, host: id }),
    go: (r, o) => navigate({ ...r, host: id }, o),
    // The hub closes a relayed socket with 4401 both when it no longer pairs
    // this device and when it lost its link to the host (spec §3 #164).
    async unauthorized() {
      let h: Hello
      try {
        h = await api.hello()
      } catch {
        return true // the hub cannot be asked now: try again later
      }
      if (!h.paired) {
        hubUnpaired()
        return false
      }
      try {
        store.applyOverview(await hostApi.overview())
        return true
      } catch (e) {
        return !(e instanceof ApiError && e.kind === 'host_unlinked')
      }
    },
    retry() {
      runs.get(id)?.stream.nudge()
      hostApi.overview().then(
        (o) =>
          batch(() => {
            store.applyOverview(o)
            unreachable.value = false
          }),
        () => {}, // the banner stays
      )
    },
  }
}

/** The scope of every host linked to the hub, by ID. */
export const scopes = signal<Map<string, HostScope>>(new Map())

export function scopeOf(id: string): HostScope | undefined {
  return scopes.value.get(id)
}

/** The hosts linked to the hub, but not the page's own. */
export const others = computed(() => hosts.value.filter((h) => !isHere(h.url)))

/** The name a host goes by; 이 호스트 while the hub has not said its own. */
export const nameOf = (s: HostScope) => s.name.value || '이 호스트'

/** The hub, then the hosts linked to it, in the hub's order. */
export const allScopes = computed(() => [hub, ...others.value.flatMap((h) => scopeOf(h.id) ?? [])])

let reading: Promise<void> | null = null

/** Reads the hub's list of hosts again; a read on its way is the one asked for. */
export function reloadHosts(): Promise<void> {
  reading ??= api.hosts
    .get()
    .then(
      (hs) =>
        batch(() => {
          hosts.value = hs
          hostsReady.value = true
        }),
      () => {}, // the next drop or overview asks again
    )
    .finally(() => {
      reading = null
    })
  return reading
}

/** What waits for a person on every host. */
export const totalNeeds = computed(() => {
  let n = hub.needs.value
  for (const s of scopes.value.values()) n += s.needs.value
  return n
})

export const HostContext = createContext<HostScope>(hub)

/** The host of the screen: the hub unless a HostContext says another. */
export function useHost(): HostScope {
  return useContext(HostContext)
}

export interface HostsOptions {
  socket?: SocketCtor
  /** Makes each wait: a stream's between drops and its restart after a 4401. */
  backoff?: () => Backoff
}

let current: (() => void) | null = null

/**
 * Keeps a scope for every host the hub lists and an event stream for each
 * linked one, until the returned function stops them. A second call while
 * they run gets the same stop.
 */
export function startHosts(o: HostsOptions = {}): () => void {
  if (current) return current
  let on = true

  const close = (id: string) => {
    const run = runs.get(id)
    if (!run) return
    runs.delete(id)
    clearTimeout(run.timer)
    run.stream.stop()
  }

  // A 4401: the hub forgot this device, lost the host, or could not say.
  const again = async (s: HostScope, run: Run) => {
    if (!(await s.unauthorized())) return
    const linked = hosts.peek().some((h) => h.id === s.id && h.linked)
    if (!on || !linked || runs.get(s.id) !== run) return
    clearTimeout(run.timer)
    run.timer = setTimeout(() => {
      run.timer = undefined
      if (on && runs.get(s.id) === run) run.stream.start()
    }, run.restart.next())
  }

  const open = (s: HostScope) => {
    const run: Run = {
      restart: o.backoff?.() ?? new Backoff(),
      stream: new EventStream({
        url: s.ws('/ws/events'),
        socket: o.socket,
        backoff: o.backoff?.(),
        apply: s.apply,
        setConn: (c) => {
          s.conn.value = c
          if (c !== 'open') return
          s.unreachable.value = false
          run.restart.reset()
          // The presets are not in the stream: ask on every open.
          s.api.overview().then(
            (ov) => {
              if (runs.get(s.id) === run) s.applyOverview(ov)
            },
            () => {},
          )
        },
        onDrop: (code) => {
          if (code === OUT_OF_REACH) s.unreachable.value = true
          else if (code === NO_SUCH_HOST) void reloadHosts()
        },
        onUnauthorized: () => void again(s, run),
      }),
    }
    runs.set(s.id, run)
    run.stream.start()
  }

  const sync = (list: Host[]) => {
    const prev = scopes.peek()
    const next = new Map<string, HostScope>()
    for (const h of list) {
      const s = prev.get(h.id) ?? makeScope(h.id)
      next.set(h.id, s)
      if (h.linked && !runs.has(h.id)) open(s)
      else if (!h.linked && runs.has(h.id)) {
        close(h.id)
        s.reset()
      }
    }
    for (const [id, s] of prev) {
      if (next.has(id)) continue
      close(id)
      s.reset()
    }
    if (next.size !== prev.size || [...next.keys()].some((id) => !prev.has(id))) scopes.value = next
  }

  const dispose = effect(() => {
    const list = others.value
    untracked(() => sync(list))
  })
  const unwake = onWake(() => {
    for (const run of runs.values()) run.stream.nudge()
  })

  const stop = () => {
    if (!on) return
    on = false
    dispose()
    unwake()
    for (const id of [...runs.keys()]) close(id)
    for (const s of scopes.peek().values()) s.reset()
    scopes.value = new Map()
    if (current === stop) current = null
  }
  current = stop
  return stop
}
