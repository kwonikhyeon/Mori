// How the page starts (spec §3 #121, #130, #131): ask the server whether
// this device is paired, then open the event stream or show pairing. A
// 4401 on the stream or a 401 from any call goes back to pairing.
import { effect, signal } from '@preact/signals'
import { api, ApiError, onUnauthorized } from './api'
import { EventStream } from './events'
import { hello, hostLabel } from './hello'
import { parseHash, route } from './router'
import { startHosts } from './scope'
import { apply, applyOverview, conn, resetStore } from './store'
import type { Hello } from './types'
import { startUpdates } from './update'
import { onWake } from './wake'

export { hello, hostLabel }

export type Phase = 'loading' | 'pair' | 'app' | 'refused'

export const phase = signal<Phase>('loading')

/** Why the server would not answer at this page's address (spec §3 #193). */
export const refusal = signal<ApiError | null>(null)

let stream: EventStream | null = null
let stops: (() => void)[] = []

async function ask(): Promise<Hello | null> {
  try {
    return await api.hello()
  } catch (e) {
    if (e instanceof ApiError && e.kind === 'bad_host') refusal.value = e
    return null
  }
}

export async function boot(): Promise<void> {
  const h = await ask()
  hello.value = h
  if (refusal.value) {
    // Nothing answers at this name: a stream would only fail on and on.
    phase.value = 'refused'
    return
  }
  if (h && !h.paired) {
    phase.value = 'pair'
    return
  }
  // Paired, or the server could not be asked: the page came from it, so
  // try the stream. Its banner says what is wrong and a 4401 still pairs.
  leavePairPath()
  start()
}

/** The pairing form succeeded. */
export function paired(): void {
  if (hello.value) hello.value = { ...hello.value, paired: true }
  leavePairPath()
  start()
}

/** /pair and a code in the hash are done with once the device is paired; the route stays. */
function leavePairPath(): void {
  if (location.pathname === '/pair') history.replaceState(null, '', '/#/')
  else if (/(^#|[?&])code=/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search + '#/')
  route.value = parseHash(location.hash)
}

function start(): void {
  if (stream) return
  phase.value = 'app'
  onUnauthorized(toPairing)
  const s = new EventStream({
    apply,
    setConn: (c) => {
      conn.value = c
    },
    onUnauthorized: toPairing,
  })
  stream = s
  stops.push(onWake(() => s.nudge()))
  // The presets and the other hosts are not in the stream: ask on every open.
  stops.push(
    effect(() => {
      if (conn.value === 'open') void loadOverview()
    }),
  )
  // A stream of its own for each host linked to this hub (spec §3 #170).
  stops.push(startHosts())
  // A new build of the hub reloads the page when that loses nothing (spec §3 #182).
  stops.push(startUpdates())
  s.start()
}

async function loadOverview(): Promise<void> {
  try {
    applyOverview(await api.overview())
  } catch {
    // Asked again soon: without the presets a new session cannot be made, and the stream may stay open for hours.
    setTimeout(() => void (conn.value === 'open' && loadOverview()), 5_000)
  }
}

/** The server forgot this device: drop the state and pair again. */
export function toPairing(): void {
  if (phase.value === 'pair') return
  shutdown()
  resetStore()
  phase.value = 'pair'
  void ask().then((h) => {
    if (phase.value === 'pair' && h) hello.value = h
  })
}

/** Closes the stream and forgets the hooks; the phase stays. */
export function shutdown(): void {
  stream?.stop()
  stream = null
  for (const stop of stops.splice(0)) stop()
  onUnauthorized(null)
}
