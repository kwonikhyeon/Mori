// What the queue and the folder screen share: a terminal's title, where its
// link goes and the one-line row.
import type { ComponentChildren } from 'preact'
import { Chip } from '../components/Chip'
import { appName, chip } from '../lib/format'
import { href } from '../lib/router'
import { presets } from '../lib/store'
import type { TerminalView } from '../lib/types'

export type Variant = 'pc' | 'phone'

export interface ListProps {
  variant: Variant
  /** The terminal open in the main pane. */
  selected?: string
  /** Open terminals with the Git aside, as the open one has it (spec §3 #121). */
  git?: boolean
}

export function titleOf(t: TerminalView): string {
  return t.display_title || appName(t, presets.value)
}

export function termHref(t: TerminalView, p: ListProps): string {
  return href({ name: 'terminal', addr: t.address, git: !!p.git })
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
  const sel = p.selected === t.address
  const cls = 'qrow' + (t.state === 'finished' ? ' is-finished' : '') + (sel ? ' is-selected' : '')
  return (
    <li>
      <a class={cls} href={termHref(t, p)} aria-current={sel ? 'true' : undefined}>
        <span class="qrow-main">
          <span class="qrow-title">{titleOf(t)}</span>
          <span class="qrow-sub">{sub}</span>
        </span>
        {end ?? <Chip info={chip(t)} />}
      </a>
    </li>
  )
}
