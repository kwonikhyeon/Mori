// "지금 볼 것" (spec §3 #122): what waits for a person first, then what is
// working, the rest folded. The PC sidebar and the phone home share it.
import { useState } from 'preact/hooks'
import { Chip } from '../components/Chip'
import { Icon } from '../components/Icon'
import { now } from '../lib/clock'
import { appName, chip, endText, finishedLine, place } from '../lib/format'
import { groupQueue, type GroupKey, type QueueGroup } from '../lib/queue'
import { folders, presets, ready, terminals } from '../lib/store'
import { relTime } from '../lib/time'
import type { TerminalView } from '../lib/types'
import { Loading, TermRow, termHref, titleOf, type ListProps } from './rows'
import './lists.css'

const ASKS: Record<string, string> = {
  permission: '실행 허가를 기다립니다',
  question: '답을 기다립니다',
  auth: '인증이 필요합니다',
}

function message(t: TerminalView, kind: 'blocked' | 'error'): string {
  const m = t.status?.msg?.trim()
  if (m) return m
  if (kind === 'error') return '오류가 났습니다'
  return ASKS[t.status?.kind ?? ''] ?? '응답을 기다립니다'
}

const appPlace = (t: TerminalView) => `${appName(t, presets.value)} · ${place(t, folders.value)}`

function AlertCard({ t, kind, p }: { t: TerminalView; kind: 'blocked' | 'error'; p: ListProps }) {
  const phone = p.variant === 'phone'
  const sel = p.selected === t.address
  return (
    <a class={`qcard qcard-${kind}` + (sel ? ' is-selected' : '')} href={termHref(t, p)} aria-current={sel ? 'true' : undefined}>
      <span class="qcard-top">
        <Chip info={chip(t)} big={phone} />
        {phone && <span class="qcard-app">{appName(t, presets.value)}</span>}
        {phone ? <Icon name="chevron-right" size={18} class="qcard-go" /> : sel && <span class="qcard-seeing">보는 중</span>}
      </span>
      <span class="qcard-title">{titleOf(t)}</span>
      <span class="qcard-sub">{phone ? place(t, folders.value) : appPlace(t)}</span>
      <span class="qcard-msg">{message(t, kind)}</span>
      {phone && kind === 'blocked' && <span class="qcard-foot">열어서 키로 응답</span>}
    </a>
  )
}

function WorkCard({ t, p }: { t: TerminalView; p: ListProps }) {
  const sel = p.selected === t.address
  const progress = t.status?.progress
  return (
    <a class={'qcard qwork' + (sel ? ' is-selected' : '')} href={termHref(t, p)} aria-current={sel ? 'true' : undefined}>
      <span class="qwork-top">
        <span class="qrow-main">
          <span class="qrow-title">{titleOf(t)}</span>
          <span class="qrow-sub">{appPlace(t)}</span>
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
          <TermRow key={t.address} t={t} p={p} sub={appPlace(t)} />
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
  const id = `q-${p.variant}-${g.key}`
  const sub = g.key === 'finished' ? finishedLine(g.items[0], presets.value, now.value) : '상태를 보고하지 않는 프로그램'
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
                sub={appPlace(t)}
                end={
                  <span class="qrow-end">
                    {endText(t)}
                    {t.finished_ms != null && ' · ' + relTime(t.finished_ms, now.value)}
                  </span>
                }
              />
            ) : (
              <TermRow key={t.address} t={t} p={p} sub={appPlace(t)} />
            ),
          )}
        </ul>
      )}
    </section>
  )
}

function EmptyQueue() {
  return (
    <div class="empty">
      <span class="empty-icon">
        <Icon name="inbox" size={26} />
      </span>
      <p class="empty-title">아직 세션이 없습니다</p>
      <p class="empty-text">새 세션을 열면 여기에 모입니다.</p>
      <a class="btn btn-primary" href="#/new">
        <Icon name="plus" stroke={2} />새 세션
      </a>
    </div>
  )
}

export function QueueList(p: ListProps) {
  const [open, setOpen] = useState<ReadonlySet<GroupKey>>(new Set())
  if (!ready.value) return <Loading />
  const groups = groupQueue(terminals.value.values(), now.value).filter((g) => g.items.length > 0)
  if (groups.length === 0) return <EmptyQueue />
  const shown = groups.filter((g) => !g.collapsed)
  const folded = groups.filter((g) => g.collapsed)
  const toggle = (k: GroupKey) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (!next.delete(k)) next.add(k)
      return next
    })
  return (
    <div class={`qv qv-${p.variant}`}>
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
    </div>
  )
}
