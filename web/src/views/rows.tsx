// What the queue and the folder screen share: a terminal's title, where its
// link goes, how long it has been in its state (spec §3 #189) and the
// one-line row, with a dot for a finish not opened here yet (#190).
import type { ComponentChildren } from 'preact'
import { Chip } from '../components/Chip'
import { now } from '../lib/clock'
import { appName, chip, since } from '../lib/format'
import { useHost, type HostScope } from '../lib/scope'
import { unseen } from '../lib/seen'
import type { Preset, TerminalView } from '../lib/types'

export type Variant = 'pc' | 'phone'

export interface ListProps {
  variant: Variant
  /** The terminal open in the main pane. */
  selected?: string
  /** Open terminals with the Git aside, as the open one has it (spec §3 #121). */
  git?: boolean
}

export function titleOf(t: TerminalView, presets: Preset[]): string {
  return t.display_title || appName(t, presets)
}

/** The terminal's screen on host h. */
export function termHref(h: HostScope, t: TerminalView, p: ListProps): string {
  return h.href({ name: 'terminal', addr: t.address, git: !!p.git })
}

// What the hub last saw of a host it cannot reach now: there to read, not to
// use (decision 164); its banner tries again.
const block = (e: Event) => {
  e.preventDefault()
  e.stopPropagation()
}

/** A list of the host shown, greyed and shut while the hub cannot reach it. */
export function ListFrame({ class: cls, children }: { class: string; children: ComponentChildren }) {
  const stale = useHost().problem.value === 'unreachable'
  return (
    <div
      class={cls + (stale ? ' is-stale' : '')}
      role={stale ? 'group' : undefined}
      aria-disabled={stale ? 'true' : undefined}
      onClickCapture={stale ? block : undefined}
    >
      {children}
    </div>
  )
}

export function Loading() {
  return (
    <p class="qnote" role="status">
      불러오는 중
    </p>
  )
}

/** "12분째", "3분 전": how long t has been in its state; nothing when its program never said. */
export function Since({ t, class: cls = 'qtime' }: { t: TerminalView; class?: string }) {
  const s = since(t, now.value)
  if (!s || t.status_ms == null) return null
  return (
    <time class={cls} dateTime={new Date(t.status_ms).toISOString()} title={s.title}>
      {s.text}
    </time>
  )
}

export interface TermRowProps {
  t: TerminalView
  p: ListProps
  sub: string
}

export function TermRow({ t, p, sub }: TermRowProps) {
  const h = useHost()
  const sel = p.selected === t.address
  const fresh = unseen(h.id, t, now.value)
  const cls = 'qrow' + (sel ? ' is-selected' : '') + (fresh ? ' is-unseen' : '')
  return (
    <li>
      <a class={cls} href={termHref(h, t, p)} aria-current={sel ? 'true' : undefined}>
        <span class="qrow-main">
          <span class="qrow-title">
            {fresh && <span class="qrow-dot" aria-hidden="true" />}
            {titleOf(t, h.presets.value)}
            {fresh && <span class="sr-only"> · 새 결과</span>}
          </span>
          <span class="qrow-sub">{sub}</span>
        </span>
        <span class="qrow-state">
          <Since t={t} />
          <Chip info={chip(t)} />
        </span>
      </a>
    </li>
  )
}
