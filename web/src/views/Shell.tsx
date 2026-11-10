// The frame around the screens (spec §3 #119, #120). PC: a header, the
// queue in a sidebar people can widen, the main area and an aside. Phone:
// 지금 볼 것, 폴더 and 설정 over a tab bar; the other screens take it all.
import { signal } from '@preact/signals'
import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { ConnBanner } from '../components/ConnBanner'
import { Icon, type IconName } from '../components/Icon'
import { Segmented } from '../components/Segmented'
import { Splitter } from '../components/Splitter'
import { hello } from '../lib/boot'
import { versionText } from '../lib/format'
import { hostState } from '../lib/health'
import { otherHosts } from '../lib/hosts'
import { isPhone, viewportWidth } from '../lib/media'
import { ASIDE, layout, loadWidth, saveWidth, SIDEBAR, type Pane } from '../lib/resize'
import { href, navigate, parseHash, route, type Route } from '../lib/router'
import { HostContext, hub, scopeOf, useHost, type HostScope } from '../lib/scope'
import { hosts, hostsReady } from '../lib/store'
import { setTheme, theme, THEME_LABEL, type ThemePref } from '../lib/theme'
import { toast } from '../lib/toast'
import { CommitPanel } from './Commit'
import { FolderList } from './Folders'
import { GitPanel, GitScreen, gitFrom } from './Git'
import { GraphScreen } from './Graph'
import { NewSession } from './NewSession'
import { QueueList } from './Queue'
import { Loading } from './rows'
import { Settings } from './Settings'
import { Terminal } from './Terminal'
import './shell.css'

/** The screens of the host the route names, or of the hub. */
export function Shell() {
  const r = route.value
  const s = r.host ? scopeOf(r.host) : hub
  // A host's link waits for the hub's list; a host the list does not have is gone.
  const gone = !!r.host && hostsReady.value && !s
  useEffect(() => {
    if (!gone) return
    hub.go({ name: 'queue' }, { replace: true })
    toast('이 허브에 없는 호스트입니다', 'error')
  }, [gone])
  if (!s) return <Loading />
  return (
    <HostContext.Provider key={s.id} value={s}>
      {isPhone.value ? <PhoneShell /> : <PcShell />}
    </HostContext.Provider>
  )
}

const thisHost = (h: HostScope) => h.name.value || '이 호스트'

/** The phone tab a full screen goes back to: the list it was opened from. */
export const phoneBack = signal('#/')

/* ---------- the screens of each route ---------- */

/** What the PC main area shows. */
function pcMain(r: Route): ComponentChildren {
  switch (r.name) {
    case 'queue':
    case 'folders':
      return <PcEmpty />
    case 'settings':
      return <Settings variant="pc" />
    case 'new':
      return <NewSession key={href(r)} variant="pc" folder={r.folder} wt={r.wt} />
    case 'terminal':
      return <Terminal key={r.addr} addr={r.addr} git={r.git} variant="pc" />
    case 'git':
      return <GitScreen key={r.folder} variant="pc" folder={r.folder} path={r.path} />
    case 'graph':
      return <GraphScreen key={r.folder} variant="pc" folder={r.folder} path={r.path} head={r.head} c={r.c} />
  }
}

interface AsideView {
  label: string
  body: ComponentChildren
}

/** What the PC aside shows, if anything. */
function pcAside(r: Route, h: HostScope): AsideView | null {
  if (r.name === 'graph')
    return r.c
      ? { label: '커밋', body: <CommitPanel key={r.folder} r={r} onClose={() => navigate({ ...r, c: undefined }, { replace: true })} /> }
      : null
  if (r.name !== 'terminal' || !r.git) return null
  const t = h.terminals.value.get(r.addr)
  return {
    label: 'Git',
    body: (
      <GitPanel
        key={r.addr}
        folder={t?.folder_id ?? ''}
        path={t?.worktree || undefined}
        pulse={t?.status_ms}
        onClose={() => h.go({ name: 'terminal', addr: r.addr, git: false })}
      />
    ),
  }
}

/** The phone screens without the tab bar. */
function phoneFull(r: Route, h: HostScope): ComponentChildren {
  // The list it was opened from, when that list is this host's.
  const back = (parseHash(phoneBack.value).host ?? '') === h.id ? phoneBack.value : h.href({ name: 'queue' })
  switch (r.name) {
    case 'new':
      return <NewSession key={href(r)} variant="phone" folder={r.folder} wt={r.wt} back={back} />
    case 'terminal':
      return <Terminal key={r.addr} addr={r.addr} variant="phone" back={back} />
    case 'git':
      return (
        <GitScreen
          key={r.folder}
          variant="phone"
          folder={r.folder}
          path={r.path}
          back={gitFrom.value ? h.href({ name: 'terminal', addr: gitFrom.value, git: false }) : h.href({ name: 'folders' })}
        />
      )
    case 'graph':
      return (
        <GraphScreen
          key={r.folder}
          variant="phone"
          folder={r.folder}
          path={r.path}
          head={r.head}
          c={r.c}
          back={h.href({ name: 'git', folder: r.folder, path: r.path })}
        />
      )
    default:
      return null
  }
}

/* ---------- PC ---------- */

type SideTab = 'queue' | 'folders'

/** A pane's width: drawn live while dragged, saved when let go. */
function usePane(p: Pane) {
  const [w, setW] = useState(() => loadWidth(p))
  return {
    w,
    set: setW,
    commit: (x: number) => saveWidth(p, x),
    reset: () => {
      setW(p.def)
      saveWidth(p, p.def)
    },
  }
}

function PcShell() {
  const h = useHost()
  const r = route.value
  const [tab, setTab] = useState<SideTab>(r.name === 'folders' ? 'folders' : 'queue')
  useEffect(() => {
    if (r.name === 'queue' || r.name === 'folders') setTab(r.name)
  }, [r.name])
  const side = usePane(SIDEBAR)
  const right = usePane(ASIDE)
  const aside = pcAside(r, h)
  const L = layout(viewportWidth.value, side.w, aside ? right.w : null)
  const pick = (t: SideTab) => {
    setTab(t)
    // Only the empty main area follows the tab; an open session stays.
    const at = route.peek().name
    if (at === 'queue' || at === 'folders') h.go({ name: t }, { replace: true })
  }
  const selected = r.name === 'terminal' ? r.addr : undefined
  const git = r.name === 'terminal' && r.git
  const asideHandle = aside && (
    <Splitter
      label={`${aside.label} 패널 너비`}
      controls="pc-aside"
      value={L.aside}
      min={ASIDE.min}
      max={L.asideMax}
      dir={-1}
      onChange={right.set}
      onCommit={right.commit}
      onReset={right.reset}
      class={L.docked ? undefined : 'splitter-over'}
      style={L.docked ? undefined : { right: `${L.aside - 8}px` }}
    />
  )
  return (
    <div class="pc">
      <PcHeader />
      <ConnBanner class="pc-banner" />
      <div class="pc-body">
        <nav id="pc-side" class="pc-side" aria-label="세션 대기열" style={{ width: `${L.sidebar}px` }}>
          <Segmented
            label="목록"
            items={[
              { value: 'queue', label: '지금 볼 것', count: h.needs.value },
              { value: 'folders', label: '폴더' },
            ]}
            value={tab}
            onChange={pick}
          />
          <div class="pc-list">
            {tab === 'queue' ? <QueueList variant="pc" selected={selected} git={git} /> : <FolderList variant="pc" selected={selected} git={git} />}
          </div>
        </nav>
        <Splitter
          label="사이드바 너비"
          controls="pc-side"
          value={L.sidebar}
          min={SIDEBAR.min}
          max={L.sidebarMax}
          dir={1}
          onChange={side.set}
          onCommit={side.commit}
          onReset={side.reset}
        />
        <div class="pc-work">
          <main class="pc-main">{pcMain(r)}</main>
          {aside && (
            <>
              {asideHandle}
              <aside id="pc-aside" class={'pc-aside' + (L.docked ? '' : ' is-over')} aria-label={aside.label} style={{ width: `${L.aside}px` }}>
                {aside.body}
              </aside>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function PcHeader() {
  const h = useHost()
  const hs = hostState(h.conn.value, h.core.value)
  const others = otherHosts(hosts.value)
  const r = route.value
  return (
    <header class="pc-head">
      <a class="wordmark" href={h.href({ name: 'queue' })}>
        Mori
      </a>
      <nav class="hostnav" aria-label="호스트">
        <span class="host-cur" aria-current="page">
          <span class={`dot dot-${hs.dot}`} aria-hidden="true" />
          <span class="host-cur-name">{thisHost(h)}</span>
          <span class="host-cur-state">{hs.text}</span>
        </span>
        {others.map((o) => (
          <a key={o.url} class="host-link" href={o.url}>
            {o.name}
            <Icon name="external" size={13} />
          </a>
        ))}
      </nav>
      <div class="pc-head-end">
        <a class="btn btn-primary" href={h.href({ name: 'new' })}>
          <Icon name="plus" stroke={2} />새 세션
        </a>
        <ThemeButton />
        <a class="btn btn-icon" href={h.href({ name: 'settings' })} aria-label="설정" title="설정" aria-current={r.name === 'settings' ? 'page' : undefined}>
          <Icon name="sliders" size={18} />
        </a>
      </div>
    </header>
  )
}

function PcEmpty() {
  const h = useHost()
  return (
    <div class="empty pc-empty">
      <span class="empty-icon">
        <Icon name="terminal" size={26} />
      </span>
      <p class="empty-title">세션을 고르세요</p>
      <p class="empty-text">왼쪽 목록에서 고르거나 새 세션을 여세요.</p>
      <a class="btn btn-primary" href={h.href({ name: 'new' })}>
        <Icon name="plus" stroke={2} />새 세션
      </a>
    </div>
  )
}

/* ---------- the theme ---------- */

const THEME_ICON: Record<ThemePref, IconName> = { system: 'monitor', light: 'sun', dark: 'moon' }
const THEME_NEXT: Record<ThemePref, ThemePref> = { system: 'light', light: 'dark', dark: 'system' }

/** System, light, dark and round again (spec §3 #118); Settings has the same choice. */
export function ThemeButton() {
  const t = theme.value
  const label = `화면 테마: ${THEME_LABEL[t]}`
  return (
    <button type="button" class="btn btn-icon" aria-label={label} title={`${label} · 누르면 ${THEME_LABEL[THEME_NEXT[t]]}`} onClick={() => setTheme(THEME_NEXT[t])}>
      <Icon name={THEME_ICON[t]} size={18} />
    </button>
  )
}

/* ---------- phone ---------- */

type Tab = 'queue' | 'folders' | 'settings'

function PhoneShell() {
  const h = useHost()
  const r = route.value
  switch (r.name) {
    case 'queue':
      return (
        <PhoneTab key="queue" tab="queue" title="지금 볼 것" fab>
          <QueueList variant="phone" />
        </PhoneTab>
      )
    case 'folders':
      return (
        <PhoneTab key="folders" tab="folders" title="폴더" fab>
          <FolderList variant="phone" />
        </PhoneTab>
      )
    case 'settings':
      return (
        <PhoneTab
          key="settings"
          tab="settings"
          title="설정"
          sub={
            <>
              <b>{thisHost(h)}</b> · 이 호스트의 알림과 기기
            </>
          }
        >
          <Settings variant="phone" />
        </PhoneTab>
      )
    default:
      return <div class="ph ph-full">{phoneFull(r, h)}</div>
  }
}

interface PhoneTabProps {
  tab: Tab
  title: string
  /** A line under the title in place of the host button. */
  sub?: ComponentChildren
  fab?: boolean
  children: ComponentChildren
}

function PhoneTab({ tab, title, sub, fab = false, children }: PhoneTabProps) {
  const h = useHost()
  useEffect(() => {
    if (tab === 'queue' || tab === 'folders') phoneBack.value = h.href({ name: tab })
    // Git opened from a list goes back to the list.
    gitFrom.value = ''
  }, [tab, h])
  return (
    <div class="ph">
      <header class="ph-head">
        <div class="ph-head-main">
          <h1>{title}</h1>
          {sub ? <p class="ph-sub">{sub}</p> : <HostMenu />}
        </div>
        {fab && (
          <a class="fab" href={h.href({ name: 'new' })} aria-label="새 세션">
            <Icon name="plus" size={24} stroke={2} />
          </a>
        )}
      </header>
      <ConnBanner class="ph-banner" />
      <div class="ph-scroll">{children}</div>
      <TabBar current={tab} />
    </div>
  )
}

/** The host's name and state; opens the other hosts. */
function HostMenu() {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      btn.current?.focus()
    }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', key)
    }
  }, [open])
  const h = useHost()
  const hs = hostState(h.conn.value, h.core.value)
  const others = otherHosts(hosts.value)
  const version = h.host.value?.version ?? (h.id === '' ? hello.value?.version : undefined)
  const close = () => setOpen(false)
  return (
    <div class="hostmenu" ref={box}>
      <button ref={btn} type="button" class="host-btn" aria-expanded={open} aria-controls={open ? 'host-pop' : undefined} onClick={() => setOpen(!open)}>
        <span class={`dot dot-${hs.dot}`} aria-hidden="true" />
        <span class="host-name">{thisHost(h)}</span>
        <span>{hs.text}</span>
        <Icon name="chevron-down" size={16} />
      </button>
      {open && (
        <div id="host-pop" class="host-pop">
          <p class="host-pop-title">이 호스트</p>
          <p class="host-pop-cur">
            <span class={`dot dot-${hs.dot}`} aria-hidden="true" />
            <b>{thisHost(h)}</b>
            <span class="host-pop-ver">{[hs.text, version && versionText(version)].filter(Boolean).join(' · ')}</span>
          </p>
          <p class="host-pop-title">다른 호스트</p>
          {others.length > 0 ? (
            <ul class="host-pop-list">
              {others.map((o) => (
                <li key={o.url}>
                  <a class="host-pop-link" href={o.url} onClick={close}>
                    {o.name}
                    <Icon name="external" size={14} />
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p class="host-pop-none">
              <a href="#/settings" onClick={close}>
                설정
              </a>
              에서 다른 컴퓨터의 Mori를 추가할 수 있습니다.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function TabBar({ current }: { current: Tab }) {
  const h = useHost()
  const n = h.needs.value
  const tab = (t: Tab, to: string, icon: IconName, label: string, extra?: ComponentChildren) => (
    <a class="tab" href={to} aria-current={current === t ? 'page' : undefined}>
      <span class="tab-icon">
        <Icon name={icon} size={22} />
        {extra}
      </span>
      {label}
      {t === 'queue' && n > 0 && <span class="sr-only">, 볼 것 {n}개</span>}
    </a>
  )
  return (
    <nav class="tabbar" aria-label="주 메뉴">
      {tab('queue', h.href({ name: 'queue' }), 'inbox', '지금 볼 것', n > 0 && (
        <span class="tab-badge" aria-hidden="true">
          {n > 99 ? '99+' : n}
        </span>
      ))}
      {tab('folders', h.href({ name: 'folders' }), 'folder', '폴더')}
      {tab('settings', h.href({ name: 'settings' }), 'sliders', '설정')}
    </nav>
  )
}
