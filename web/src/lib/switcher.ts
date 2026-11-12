// 세션 이동 (spec §3 #198): every session of the hosts the page can reach,
// to open one by a part of its name, and the step to the next session that
// waits for approval.

import { signal } from '@preact/signals'
import { appName, place } from './format'
import { GROUP_TITLE, groupQueue, type GroupKey } from './queue'
import { route, type Route } from './router'
import { allScopes, nameOf, type HostScope } from './scope'
import { toast } from './toast'
import type { TerminalView } from './types'

/** Whether 세션 이동 is open. */
export const switcherOpen = signal(false)

export const openSwitcher = () => {
  switcherOpen.value = true
}

export const closeSwitcher = () => {
  switcherOpen.value = false
}

/** A session and its host. */
export interface Found {
  s: HostScope
  t: TerminalView
}

export interface Entry extends Found {
  group: GroupKey
  title: string
  /** "Claude Code · Mori / main", and the host when there is more than one. */
  sub: string
  /** What a query is looked for in, in lower case. */
  hay: string
}

/** The session a route shows, if it shows one. */
export interface Spot {
  host: string
  addr: string
}

export function spotOf(r: Route): Spot | null {
  return r.name === 'terminal' ? { host: r.host ?? '', addr: r.addr } : null
}

export const isAt = (f: Found, at: Spot | null): boolean => !!at && f.s.id === at.host && f.t.address === at.addr

/** A host whose sessions can be opened now: listed, and reached. */
const usable = (s: HostScope) => !s.problem.value && s.ready.value

/**
 * The sessions of every host it can reach: the queue's groups in their order
 * (승인 대기 first, 상태 없음 last), each group host by host as the queue
 * orders it.
 */
export function entriesOf(scopes: HostScope[]): Entry[] {
  const many = scopes.length > 1
  const by = new Map<GroupKey, Entry[]>()
  for (const s of scopes) {
    if (!usable(s)) continue
    const presets = s.presets.value
    const folders = s.folders.value
    const host = nameOf(s)
    for (const g of groupQueue(s.terminals.value.values())) {
      const list = by.get(g.key) ?? []
      by.set(g.key, list)
      for (const t of g.items) {
        const app = appName(t, presets)
        const title = t.display_title || app
        const where = place(t, folders)
        list.push({
          s,
          t,
          group: g.key,
          title,
          sub: [app, where, many ? host : ''].filter(Boolean).join(' · '),
          hay: [title, app, where, host, GROUP_TITLE[g.key]].join('\n').toLowerCase(),
        })
      }
    }
  }
  return [...by.values()].flat()
}

/**
 * The entries with every word of q: first the ones whose title starts with
 * q, then the ones whose title has it, then the rest, each in their order.
 */
export function filterEntries(es: Entry[], q: string): Entry[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return es
  const whole = words.join(' ')
  const rank = new Map<Entry, number>()
  for (const e of es) {
    if (!words.every((w) => e.hay.includes(w))) continue
    const t = e.title.toLowerCase()
    rank.set(e, t.startsWith(whole) ? 0 : t.includes(whole) ? 1 : 2)
  }
  return [...rank.keys()].sort((a, b) => rank.get(a)! - rank.get(b)!)
}

/** The sessions that wait for approval on every host it can reach, each host's as its queue orders them. */
export function blockedOf(scopes: HostScope[]): Found[] {
  const out: Found[] = []
  for (const s of scopes) {
    if (!usable(s)) continue
    const g = groupQueue(s.terminals.value.values()).find((x) => x.key === 'blocked')
    for (const t of g?.items ?? []) out.push({ s, t })
  }
  return out
}

/** The one after (1) or before (-1) the session at, round the list; null when no other is there. */
export function stepFrom(list: Found[], at: Spot | null, dir: 1 | -1): Found | null {
  const n = list.length
  const i = list.findIndex((f) => isAt(f, at))
  if (!n || (i >= 0 && n === 1)) return null
  if (i < 0) return list[dir > 0 ? 0 : n - 1]
  return list[(i + dir + n) % n]
}

/** Opens the next (1) or the previous (-1) session that waits for approval; says so when no other waits. */
export function stepBlocked(dir: 1 | -1): void {
  const r = route.peek()
  const list = blockedOf(allScopes.peek())
  const to = stepFrom(list, spotOf(r), dir)
  if (!to) {
    toast(list.length ? '다른 승인 대기 세션이 없습니다' : '승인 대기 세션이 없습니다')
    return
  }
  // A PC keeps the Git panel the screen has, as the list's links do.
  to.s.go({ name: 'terminal', addr: to.t.address, git: r.name === 'terminal' && r.git })
}
