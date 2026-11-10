// "지금 볼 것" (spec §3 #122): what waits for a person first, then what is
// working, the rest folded. The PC sidebar and the phone home share it.
import type { ComponentChildren } from 'preact'
import { useState } from 'preact/hooks'
import { Chip } from '../components/Chip'
import { Icon } from '../components/Icon'
import { now } from '../lib/clock'
import { appName, askText, chip, endText, finishedLine, place } from '../lib/format'
import { groupQueue, type GroupKey, type QueueGroup } from '../lib/queue'
import { useHost } from '../lib/scope'
import type { HostStore } from '../lib/store'
import { relTime } from '../lib/time'
import type { TerminalView } from '../lib/types'
import { Loading, TermRow, termHref, titleOf, type ListProps } from './rows'
import './lists.css'

const appPlace = (h: HostStore, t: TerminalView) => `${appName(t, h.presets.value)} · ${place(t, h.folders.value)}`

function AlertCard({ t, kind, p }: { t: TerminalView; kind: 'blocked' | 'error'; p: ListProps }) {
  const h = useHost()
  const phone = p.variant === 'phone'
  const sel = p.selected === t.address
  return (
    <a class={`qcard qcard-${kind}` + (sel ? ' is-selected' : '')} href={termHref(h, t, p)} aria-current={sel ? 'true' : undefined}>
      <span class="qcard-top">
        <Chip info={chip(t)} big={phone} />
        {phone && <span class="qcard-app">{appName(t, h.presets.value)}</span>}
        {phone ? <Icon name="chevron-right" size={18} class="qcard-go" /> : sel && <span class="qcard-seeing">보는 중</span>}
      </span>
      <span class="qcard-title">{titleOf(t, h.presets.value)}</span>
      <span class="qcard-sub">{phone ? place(t, h.folders.value) : appPlace(h, t)}</span>
      <span class="qcard-msg">{askText(t, kind)}</span>
      {phone && kind === 'blocked' && <span class="qcard-foot">열어서 키로 응답</span>}
    </a>
  )
}

function WorkCard({ t, p }: { t: TerminalView; p: ListProps }) {
  const h = useHost()
  const sel = p.selected === t.address
  const progress = t.status?.progress
  return (
    <a class={'qcard qwork' + (sel ? ' is-selected' : '')} href={termHref(h, t, p)} aria-current={sel ? 'true' : undefined}>
      <span class="qwork-top">
        <span class="qrow-main">
          <span class="qrow-title">{titleOf(t, h.presets.value)}</span>
          <span class="qrow-sub">{appPlace(h, t)}</span>
        </span>
        <Chip info={chip(t)} />
      </span>
      {progress != null && (
        <span class="bar" aria-hidden="true">
          <span style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} />
        </span>
      )}
    </a>
  )
}

function rowsClass(p: ListProps): string {
  return 'qrows' + (p.variant === 'phone' ? ' qrows-joined' : '')
}

function Group({ g, p }: { g: QueueGroup; p: ListProps }) {
  const h = useHost()
  const id = `q-${p.variant}-${g.key}`
  const k = g.key
  let body
  if (k === 'blocked' || k === 'error') {
    body = g.items.map((t) => <AlertCard key={t.address} t={t} kind={k} p={p} />)
  } else if (k === 'working') {
    body = g.items.map((t) => <WorkCard key={t.address} t={t} p={p} />)
  } else {
    body = (
      <ul class={rowsClass(p)}>
        {g.items.map((t) => (
          <TermRow key={t.address} t={t} p={p} sub={appPlace(h, t)} />
        ))}
      </ul>
    )
  }
  return (
    <section class="qsec" aria-labelledby={id}>
      <h2 id={id} class="qsec-title">
        {g.title} {g.items.length}
      </h2>
      {body}
    </section>
  )
}

function Fold({ g, p, open, onToggle }: { g: QueueGroup; p: ListProps; open: boolean; onToggle: () => void }) {
  const h = useHost()
  const id = `q-${p.variant}-${g.key}`
  const sub = g.key === 'finished' ? finishedLine(g.items[0], h.presets.value, now.value) : '상태를 보고하지 않는 프로그램'
  return (
    <section class="qfold-sec" aria-labelledby={id}>
      <h2 class="qfold-h">
        <button id={id} type="button" class="qfold" aria-expanded={open} aria-controls={open ? id + '-list' : undefined} onClick={onToggle}>
          <Icon name="chevron-right" size={16} />
          <span class="qfold-title">
            {g.title} {g.items.length}
          </span>
          {!open && <span class="qfold-sub">{sub}</span>}
        </button>
      </h2>
      {open && (
        <ul id={id + '-list'} class={rowsClass(p)}>
          {g.items.map((t) =>
            t.state === 'finished' ? (
              <TermRow
                key={t.address}
                t={t}
                p={p}
                sub={appPlace(h, t)}
                end={
                  <span class="qrow-end">
                    {endText(t)}
                    {t.finished_ms != null && ' · ' + relTime(t.finished_ms, now.value)}
                  </span>
                }
              />
            ) : (
              <TermRow key={t.address} t={t} p={p} sub={appPlace(h, t)} />
            ),
          )}
        </ul>
      )}
    </section>
  )
}

function EmptyQueue() {
  const h = useHost()
  return (
    <div class="empty">
      <span class="empty-icon">
        <Icon name="inbox" size={26} />
      </span>
      <p class="empty-title">아직 세션이 없습니다</p>
      <p class="empty-text">새 세션을 열면 여기에 모입니다.</p>
      <a class="btn btn-primary" href={h.href({ name: 'new' })}>
        <Icon name="plus" stroke={2} />새 세션
      </a>
    </div>
  )
}

// What the hub last saw of a host it cannot reach now: there to read, not to
// use (decision 164); its banner tries again.
const block = (e: Event) => {
  e.preventDefault()
  e.stopPropagation()
}

export function QueueList(p: ListProps) {
  const h = useHost()
  const [open, setOpen] = useState<ReadonlySet<GroupKey>>(new Set())
  if (!h.ready.value) return <Loading />
  const stale = h.problem.value === 'unreachable'
  const frame = (body: ComponentChildren) => (
    <div
      class={`qv qv-${p.variant}` + (stale ? ' is-stale' : '')}
      role={stale ? 'group' : undefined}
      aria-disabled={stale ? 'true' : undefined}
      onClickCapture={stale ? block : undefined}
    >
      {body}
    </div>
  )
  const groups = groupQueue(h.terminals.value.values(), now.value).filter((g) => g.items.length > 0)
  if (groups.length === 0) return frame(<EmptyQueue />)
  const shown = groups.filter((g) => !g.collapsed)
  const folded = groups.filter((g) => g.collapsed)
  const toggle = (k: GroupKey) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (!next.delete(k)) next.add(k)
      return next
    })
  return frame(
    <>
      {shown.length === 0 && <p class="qnote">지금 응답할 세션이 없습니다</p>}
      {shown.map((g) => (
        <Group key={g.key} g={g} p={p} />
      ))}
      {folded.length > 0 && (
        <div class="qfolds">
          {folded.map((g) => (
            <Fold key={g.key} g={g} p={p} open={open.has(g.key)} onToggle={() => toggle(g.key)} />
          ))}
        </div>
      )}
    </>,
  )
}
