// What the queue and the folder screen share: a terminal's title, where its
// link goes, how long it has been in its state (spec §3 #189) and the
// one-line row, with a dot for a finish not opened here yet (#190), and its
// context menu (#242).
import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { Chip } from '../components/Chip'
import { Confirm } from '../components/Confirm'
import { onContext } from '../components/ContextMenu'
import type { MenuItem } from '../components/Menu'
import { now } from '../lib/clock'
import { copyAndTell } from '../lib/copy'
import { appName, chip, since } from '../lib/format'
import { useHost, type HostScope } from '../lib/scope'
import { unseen } from '../lib/seen'
import { toastError } from '../lib/toast'
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
  const [renaming, setRenaming] = useState(false)
  const [killing, setKilling] = useState(false)
  const [killBusy, setKillBusy] = useState(false)
  const sel = p.selected === t.address
  const fresh = unseen(h.id, t, now.value)
  const cls = 'qrow' + (sel ? ' is-selected' : '') + (fresh ? ' is-unseen' : '')
  const href = termHref(h, t, p)
  const title = titleOf(t, h.presets.value)

  const rename = (next: string | null) => {
    setRenaming(false)
    if (next !== null) h.api.terminals.rename(t.address, next).catch((e) => toastError(e, '이름을 바꾸지 못했습니다'))
  }
  const kill = async () => {
    setKillBusy(true)
    try {
      await h.api.terminals.kill(t.address)
    } catch (e) {
      toastError(e, '종료하지 못했습니다')
    } finally {
      setKillBusy(false)
      setKilling(false)
    }
  }
  const items = (): MenuItem[] => {
    const live = t.state === 'live'
    return [
      { label: '열기', icon: 'terminal', onSelect: () => h.go({ name: 'terminal', addr: t.address, git: !!p.git }) },
      { label: '새 창에서 열기', icon: 'external', onSelect: () => window.open(href, '_blank', 'noopener') },
      { label: '이름 바꾸기', icon: 'pencil', sep: true, onSelect: () => setRenaming(true) },
      ...(t.cwd ? [{ label: '작업 폴더 경로 복사', icon: 'copy', onSelect: () => void copyAndTell(t.cwd, '경로를 복사했습니다') } satisfies MenuItem] : []),
      ...(live
        ? ([
            { label: '중단', icon: 'stop', sep: true, onSelect: () => h.api.terminals.interrupt(t.address).catch((e) => toastError(e, '중단하지 못했습니다')) },
            { label: '종료', icon: 'power', danger: true, onSelect: () => setKilling(true) },
          ] satisfies MenuItem[])
        : []),
    ]
  }

  return (
    <li>
      {renaming ? (
        <div class={cls + ' is-renaming'}>
          <RenameField initial={t.labels?.['mori.title'] ?? title} onDone={rename} />
        </div>
      ) : (
        <a class={cls} href={href} aria-current={sel ? 'true' : undefined} onContextMenu={onContext(title, items)}>
          <span class="qrow-main">
            <span class="qrow-title">
              {fresh && <span class="qrow-dot" aria-hidden="true" />}
              {title}
              {fresh && <span class="sr-only"> · 새 결과</span>}
            </span>
            <span class="qrow-sub">{sub}</span>
          </span>
          <span class="qrow-state">
            <Since t={t} />
            <Chip info={chip(t)} />
          </span>
        </a>
      )}
      <Confirm
        open={killing}
        title="이 세션을 종료할까요?"
        text="먼저 종료를 요청하고, 끝나지 않으면 강제로 끝냅니다."
        confirm="종료"
        danger
        busy={killBusy}
        onConfirm={() => void kill()}
        onCancel={() => setKilling(false)}
      />
    </li>
  )
}

/** A session's name being changed: Enter or leaving keeps it, Escape does not. */
export function RenameField({ initial, onDone }: { initial: string; onDone: (next: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const finish = (keepIt: boolean) => {
    if (done.current) return
    done.current = true
    const v = (ref.current?.value ?? '').trim()
    onDone(keepIt && v !== initial ? v : null)
  }
  return (
    <input
      ref={ref}
      class="input term-rename"
      aria-label="세션 이름"
      maxLength={100}
      defaultValue={initial}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.isComposing) {
          e.preventDefault()
          finish(true)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          finish(false)
        }
      }}
      onBlur={() => finish(true)}
    />
  )
}
