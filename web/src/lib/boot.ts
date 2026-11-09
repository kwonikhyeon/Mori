// How the page starts (spec §3 #121, #130, #131): ask the server whether
// this device is paired, then open the event stream or show pairing. A
// 4401 on the stream or a 401 from any call goes back to pairing.
import { computed, effect, signal } from '@preact/signals'
import { api, onUnauthorized } from './api'
import { EventStream } from './events'
import { parseHash, route } from './router'
import { apply, applyOverview, conn, host, resetStore } from './store'
import type { Hello } from './types'
import { onWake } from './wake'

export type Phase = 'loading' | 'pair' | 'app'

export const phase = signal<Phase>('loading')
/** What GET /api/hello said; null when it could not be asked. */
export const hello = signal<Hello | null>(null)
/** This host's name: the overview's once it came, hello's before. */
export const hostLabel = computed(() => host.value?.name ?? hello.value?.host ?? '')

let stream: EventStream | null = null
let stops: (() => void)[] = []

async function ask(): Promise<Hello | null> {
  try {
    return await api.hello()
  } catch {
    return null
  }
}

export async function boot(): Promise<void> {
  const h = await ask()
  hello.value = h
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
  s.start()
}

async function loadOverview(): Promise<void> {
  try {
    applyOverview(await api.overview())
  } catch {
    // the banner says what is wrong; the next open asks again
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
