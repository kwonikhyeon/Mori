// What the queue and the folder screen share: a terminal's title, where its
// link goes and the one-line row.
import type { ComponentChildren } from 'preact'
import { Chip } from '../components/Chip'
import { appName, chip } from '../lib/format'
import { useHost, type HostScope } from '../lib/scope'
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

export interface TermRowProps {
  t: TerminalView
  p: ListProps
  sub: string
  /** What stands on the right; the state chip unless given. */
  end?: ComponentChildren
}

export function TermRow({ t, p, sub, end }: TermRowProps) {
  const h = useHost()
  const sel = p.selected === t.address
  const cls = 'qrow' + (t.state === 'finished' ? ' is-finished' : '') + (sel ? ' is-selected' : '')
  return (
    <li>
      <a class={cls} href={termHref(h, t, p)} aria-current={sel ? 'true' : undefined}>
        <span class="qrow-main">
          <span class="qrow-title">{titleOf(t, h.presets.value)}</span>
          <span class="qrow-sub">{sub}</span>
        </span>
        {end ?? <Chip info={chip(t)} />}
      </a>
    </li>
  )
}
