// One host at a time, switched from the header (spec §3 #170, candidate A):
// a picker in the PC header, a button and a sheet on a phone, and a badge for
// what waits on another host.
import { computed, signal } from '@preact/signals'
import { useEffect, useId, useRef } from 'preact/hooks'
import { Icon } from '../components/Icon'
import { Menu } from '../components/Menu'
import { Sheet, SheetHead } from '../components/Sheet'
import { versionText } from '../lib/format'
import { scopeState } from '../lib/health'
import { GROUP_TITLE, type GroupKey } from '../lib/queue'
import { route } from '../lib/router'
import { hub, others, scopeOf, useHost, type HostScope } from '../lib/scope'
import { hosts } from '../lib/store'
import './hostswitch.css'

const COUNTED: GroupKey[] = ['blocked', 'error', 'waiting', 'working']
const WAITING: GroupKey[] = ['blocked', 'error', 'waiting']

/** The groups that have sessions, as "승인 대기 1 · 작업 중 2". */
export function countText(c: Record<GroupKey, number>): string {
  return COUNTED.filter((k) => c[k] > 0)
    .map((k) => `${GROUP_TITLE[k]} ${c[k]}`)
    .join(' · ')
}

/** The name a host goes by; 이 호스트 while the hub has not said its own. */
export const nameOf = (s: HostScope) => s.name.value || '이 호스트'

/** The hub, then the hosts linked to it. */
const all = computed(() => [hub, ...others.value.flatMap((h) => scopeOf(h.id) ?? [])])

/** The host a switch went to: its header button takes the focus when it comes. */
let focusOn: string | null = null

/** Opens host s on the tab the screen is on: 폴더 and 설정 stay, the rest is 지금 볼 것. */
export function switchTo(s: HostScope): void {
  const r = route.peek()
  if ((r.host ?? '') !== s.id) focusOn = s.id
  s.go({ name: r.name === 'folders' || r.name === 'settings' ? r.name : 'queue' })
}

// The whole frame is made again for the other host, so the button the focus
// was on is gone; the one of the same place takes it.
function useSwitchFocus(id: string, focus: () => void) {
  useEffect(() => {
    const mine = focusOn === id
    focusOn = null
    if (mine) focus()
  }, [])
}

function useCurrent() {
  const cur = useHost()
  const st = scopeState(cur.conn.value, cur.core.value, cur.problem.value)
  return { cur, st, label: `호스트 ${nameOf(cur)} · ${st.text}` }
}

/** The PC header's host: its state, and the other hosts to switch to. */
export function HostPicker() {
  const { cur, st, label } = useCurrent()
  // Menu keeps its button to itself; the dot is inside it.
  const mark = useRef<HTMLSpanElement>(null)
  useSwitchFocus(cur.id, () => mark.current?.closest('button')?.focus())
  return (
    <Menu
      label={label}
      radio
      buttonClass="hostpick"
      trigger={
        <>
          <span ref={mark} class={`dot dot-${st.dot}`} aria-hidden="true" />
          <span class="hostpick-name">{nameOf(cur)}</span>
          <span class="hostpick-state">{st.text}</span>
          <Icon name="chevron-down" size={14} />
        </>
      }
      items={[
        ...all.value.map((s) => ({
          key: s.id || 'hub',
          label: [nameOf(s), countText(s.counts.value), s.problem.value && scopeState(s.conn.value, s.core.value, s.problem.value).text]
            .filter(Boolean)
            .join(' · '),
          checked: s.id === cur.id,
          onSelect: () => switchTo(s),
        })),
        { key: 'manage', label: '호스트 관리', onSelect: () => hub.go({ name: 'settings' }) },
      ]}
    />
  )
}

/** Whether the phone's host sheet is open. */
export const hostSheet = signal(false)

/** The button the sheet was opened from, to give the focus back to. */
let opener: HTMLElement | null = null

const closeSheet = () => {
  hostSheet.value = false
}

/** Opens the host sheet; the focus goes back to from when it closes. */
export function openHostSheet(from: HTMLElement | null): void {
  opener = from
  hostSheet.value = true
}

/** The phone header's host: its state; opens the host sheet. */
export function HostButton() {
  const { cur, st, label } = useCurrent()
  const ref = useRef<HTMLButtonElement>(null)
  useSwitchFocus(cur.id, () => ref.current?.focus())
  return (
    <button
      ref={ref}
      type="button"
      class="host-btn"
      aria-haspopup="dialog"
      aria-label={label}
      onClick={() => openHostSheet(ref.current)}
    >
      <span class={`dot dot-${st.dot}`} aria-hidden="true" />
      <span class="host-name">{nameOf(cur)}</span>
      <span>{st.text}</span>
      <Icon name="chevron-down" size={16} />
    </button>
  )
}

/** Every host on a phone, to switch to one. */
export function HostSheet() {
  const open = hostSheet.value
  const id = useId()
  // The dialog closes in Sheet's effect, which runs before this one.
  const shown = useRef(false)
  useEffect(() => {
    if (open) shown.current = true
    else if (shown.current) {
      shown.current = false
      if (opener?.isConnected) opener.focus()
    }
  }, [open])
  // A screen left with the sheet open does not open it on the next one.
  useEffect(() => closeSheet, [])
  return (
    <Sheet open={open} labelledBy={id} onClose={closeSheet} class="hs">
      <HostList id={id} />
    </Sheet>
  )
}

function HostList({ id }: { id: string }) {
  const cur = useHost()
  return (
    <>
      <SheetHead id={id} title="호스트" onClose={closeSheet} />
      <div class="sheet-body">
        <p class="hs-note">이 폰은 허브 {nameOf(hub)}에 페어링했습니다. 다른 호스트도 이 허브를 거쳐 엽니다.</p>
        <ul class="hs-list" aria-label="호스트 목록">
          {all.value.map((s) => (
            <HostRow key={s.id || 'hub'} s={s} current={s.id === cur.id} />
          ))}
        </ul>
      </div>
      <footer class="sheet-foot">
        <a class="btn btn-block" href={hub.href({ name: 'settings' })} onClick={closeSheet}>
          <Icon name="sliders" size={16} />
          설정에서 호스트 관리
        </a>
      </footer>
    </>
  )
}

function HostRow({ s, current }: { s: HostScope; current: boolean }) {
  const st = scopeState(s.conn.value, s.core.value, s.problem.value)
  const listed = hosts.value.find((h) => h.id === s.id)
  const sub =
    s.id === ''
      ? '이 폰이 페어링한 곳'
      : s.problem.value === 'unlinked'
        ? '새 코드로 다시 연결해야 합니다'
        : [st.text, listed && versionText(listed.version)].filter(Boolean).join(' · ')
  const count = countText(s.counts.value)
  return (
    <li>
      <button
        type="button"
        class="hs-row"
        aria-current={current ? 'true' : undefined}
        autofocus={current}
        onClick={() => {
          switchTo(s)
          closeSheet()
        }}
      >
        <span class={`dot dot-${st.dot}`} aria-hidden="true" />
        <span class="hs-main">
          <span class="hs-name">
            {nameOf(s)}
            {s.id === '' && <span class="hs-pill">허브</span>}
          </span>
          <span class="hs-sub">{sub}</span>
        </span>
        {count && <span class="hs-count">{count}</span>}
        {current && <Icon name="check" size={18} class="hs-check" />}
      </button>
    </li>
  )
}

/**
 * The other host where the most waits for a person: 승인 대기 first, then
 * 오류, then 입력 대기; the first in the list when even. Nothing when none waits.
 */
export function OthersBadge() {
  const cur = useHost()
  const from = all.value.filter((s) => s.id !== cur.id && !s.problem.value)
  for (const k of WAITING) {
    let best: HostScope | null = null
    let n = 0
    for (const s of from) {
      const c = s.counts.value[k]
      if (c > n) {
        best = s
        n = c
      }
    }
    if (!best) continue
    const label = `${nameOf(best)} ${GROUP_TITLE[k]} ${n}`
    return (
      <a class={`others others-${k}`} href={best.href({ name: 'queue' })} aria-label={label} title={label}>
        {n}
      </a>
    )
  }
  return null
}
