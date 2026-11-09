// "지금 볼 것": the terminals grouped by what they need (spec §3 #122), and
// the same terminals by folder for the folder screen.

import { stateKind } from './format'
import type { FolderView, TerminalView } from './types'

export type GroupKey = 'blocked' | 'error' | 'waiting' | 'working' | 'none' | 'finished'

export interface QueueGroup {
  key: GroupKey
  title: string
  items: TerminalView[]
  /** Shown folded until opened. */
  collapsed: boolean
}

const RECENT = 24 * 3_600_000

const GROUPS: [GroupKey, string][] = [
  ['blocked', '승인 대기'],
  ['error', '오류'],
  ['waiting', '입력 대기'],
  ['working', '작업 중'],
  ['none', '상태 없음'],
  ['finished', '최근 종료'],
]

const changed = (t: TerminalView) => t.status_ms ?? t.created_ms
const latestFirst = (key: (t: TerminalView) => number) => (a: TerminalView, b: TerminalView) => key(b) - key(a)

/** Every group in its order, empty ones too; the screen skips those. */
export function groupQueue(ts: Iterable<TerminalView>, now: number): QueueGroup[] {
  const by = new Map<GroupKey, TerminalView[]>(GROUPS.map(([k]) => [k, []]))
  for (const t of ts) {
    const k = stateKind(t)
    if (k === 'exited') {
      if (t.finished_ms != null && now - t.finished_ms < RECENT) by.get('finished')!.push(t)
      continue
    }
    by.get(k)!.push(t)
  }
  return GROUPS.map(([key, title]) => {
    const items = by.get(key)!
    items.sort(latestFirst(key === 'finished' ? (t) => t.finished_ms ?? 0 : changed))
    return { key, title, items, collapsed: key === 'none' || key === 'finished' }
  })
}

/** The badge: what waits for a person. */
export function needsCount(groups: QueueGroup[]): number {
  return groups.filter((g) => g.key === 'blocked' || g.key === 'error' || g.key === 'waiting').reduce((n, g) => n + g.items.length, 0)
}

export interface FolderGroup {
  /** null is 기타: other machines and folders no longer registered. */
  folder: FolderView | null
  items: TerminalView[]
}

/** The folders in their order with their terminals, newest first, the finished ones last. */
export function groupByFolder(ts: Iterable<TerminalView>, folders: FolderView[]): FolderGroup[] {
  const known = new Set(folders.map((f) => f.id))
  const by = new Map<string, TerminalView[]>()
  for (const t of ts) {
    const id = known.has(t.folder_id) ? t.folder_id : ''
    if (!by.has(id)) by.set(id, [])
    by.get(id)!.push(t)
  }
  const order = (a: TerminalView, b: TerminalView) => {
    const fa = a.state === 'finished' ? 1 : 0
    const fb = b.state === 'finished' ? 1 : 0
    return fa - fb || b.created_ms - a.created_ms
  }
  const groups: FolderGroup[] = folders.map((f) => ({ folder: f, items: (by.get(f.id) ?? []).sort(order) }))
  const rest = by.get('')
  if (rest?.length) groups.push({ folder: null, items: rest.sort(order) })
  return groups
}
