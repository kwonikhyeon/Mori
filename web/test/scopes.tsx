// Hosts linked to the hub for a test: a scope for each, without their
// streams, put back when the test ends.
import { batch } from '@preact/signals'
import type { ComponentChildren } from 'preact'
import { onTestFinished } from 'vitest'
import { HostContext, makeScope, scopes, type HostScope } from '../src/lib/scope'
import { hosts, hostsReady } from '../src/lib/store'
import type { Host } from '../src/lib/types'
import { linkedHost } from './fixtures'

export function withHosts(...over: Partial<Host>[]): HostScope[] {
  const list = over.map((o) => linkedHost(o))
  const made = list.map((h) => makeScope(h.id))
  // All at once: a screen never sees the list without its scopes.
  batch(() => {
    scopes.value = new Map(made.map((s) => [s.id, s]))
    hosts.value = list
    hostsReady.value = true
  })
  onTestFinished(() => {
    batch(() => {
      for (const s of made) s.reset()
      scopes.value = new Map()
      hosts.value = []
      hostsReady.value = false
    })
  })
  return made
}

export function withHost(over: Partial<Host> = {}): HostScope {
  return withHosts(over)[0]
}

/** node as a screen of host s. */
export function inHost(s: HostScope, node: ComponentChildren) {
  return <HostContext.Provider value={s}>{node}</HostContext.Provider>
}
