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
import { layersOpen } from '../lib/backstack'
import { backSwipe } from '../lib/backswipe'
import { isPhone, viewportWidth } from '../lib/media'
import { isApple } from '../lib/platform'
import { ASIDE, layout, loadWidth, saveWidth, SIDEBAR, type Pane } from '../lib/resize'
import { href, navigate, parseHash, route, type Route } from '../lib/router'
import { HostContext, hub, nameOf, scopeOf, useHost, type HostScope } from '../lib/scope'
import { hostsReady } from '../lib/store'
import { startShortcuts } from '../lib/shortcuts'
import { closeSwitcher, openSwitcher, stepBlocked, switcherOpen } from '../lib/switcher'
import { setTheme, theme, THEME_LABEL, type ThemePref } from '../lib/theme'
import { toast } from '../lib/toast'
import { newBuild } from '../lib/update'
import { CommitPanel } from './Commit'
import { FolderList } from './Folders'
import { GitPanel, GitScreen, gitFrom } from './Git'
import { GraphScreen } from './Graph'
import { HostProblem } from './HostProblem'
import { HostButton, HostPicker, HostSheet, OthersBadge } from './HostSwitch'
import { NewSession } from './NewSession'
import { QueueList } from './Queue'
import { Loading } from './rows'
import { Settings } from './Settings'
import { settingsSub } from './SettingsHosts'
import { Switcher } from './Switcher'
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
  useEffect(
    () => startShortcuts((k) => (k === 'switch' ? (switcherOpen.peek() ? closeSwitcher() : openSwitcher()) : stepBlocked(k === 'next' ? 1 : -1)), { apple: isApple(), own: 'qs' }),
    [],
  )
  if (!s) return <Loading />
  return (
    <>
      <HostContext.Provider key={s.id} value={s}>
        {isPhone.value ? <PhoneShell /> : <PcShell />}
      </HostContext.Provider>
      <Switcher />
    </>
  )
}

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

/** A phone screen without the tab bar, and where its ‹ goes. */
interface FullView {
  back: string
  body: ComponentChildren
}

/** The phone screens without the tab bar. */
function phoneFull(r: Route, h: HostScope): FullView | null {
  // The list it was opened from, when that list is this host's.
  const back = (parseHash(phoneBack.value).host ?? '') === h.id ? phoneBack.value : h.href({ name: 'queue' })
  switch (r.name) {
    case 'new':
      return { back, body: <NewSession key={href(r)} variant="phone" folder={r.folder} wt={r.wt} back={back} /> }
    case 'terminal':
      return { back, body: <Terminal key={r.addr} addr={r.addr} variant="phone" back={back} /> }
    case 'git': {
      const up = gitFrom.value ? h.href({ name: 'terminal', addr: gitFrom.value, git: false }) : h.href({ name: 'folders' })
      return { back: up, body: <GitScreen key={r.folder} variant="phone" folder={r.folder} path={r.path} back={up} /> }
    }
    case 'graph': {
      const up = h.href({ name: 'git', folder: r.folder, path: r.path })
      return {
        back: up,
        body: <GraphScreen key={r.folder} variant="phone" folder={r.folder} path={r.path} head={r.head} c={r.c} back={up} />,
      }
    }
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
  // An unlinked host has nothing to list or open: the header stays to pick another.
  if (h.problem.value === 'unlinked') {
    return (
      <div class="pc">
        <PcHeader />
        <div class="pc-body">
          <main class="pc-main">
            <HostProblem variant="pc" />
          </main>
        </div>
      </div>
    )
  }
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
      <PcHeader side={L.sidebar} />
      <ConnBanner class="pc-banner" list />
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

/** side: the sidebar's drawn width, when there is one; the field then starts where the main area does (spec §3 #235). */
function PcHeader({ side }: { side?: number }) {
  const h = useHost()
  const r = route.value
  const fresh = newBuild.value !== null
  return (
    <header class={'pc-head' + (side ? ' has-side' : '')} style={side ? `--pc-side: ${side}px` : undefined}>
      <div class="pc-head-start">
        <a class="pc-logo" href={h.href({ name: 'queue' })} aria-label="Mori, 지금 볼 것" title="Mori">
          <img src="/icons/icon-192.png" alt="" width="24" height="24" />
        </a>
        <div class="hostbar">
          <HostPicker />
          <OthersBadge />
        </div>
      </div>
      <SwitchField />
      <div class="pc-head-end">
        <a class="btn btn-icon btn-sm btn-primary" href={h.href({ name: 'new' })} aria-label="새 세션" title="새 세션">
          <Icon name="plus" stroke={2} />
        </a>
        <ThemeButton />
        <a class="btn btn-icon btn-sm btn-ghost" href={h.href({ name: 'settings' })} aria-label={fresh ? '설정, 새 버전이 있습니다' : '설정'} title={fresh ? '설정 · 새 버전이 있습니다' : '설정'} aria-current={r.name === 'settings' ? 'page' : undefined}>
          <Icon name="sliders" size={18} />
          {fresh && <span class="nav-dot" aria-hidden="true" />}
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

/** Opens 세션 이동, as ⌘P or Ctrl+P does: a field in the middle of the title bar (spec §3 #232). */
function SwitchField() {
  const apple = isApple()
  const keys = apple ? '⌘P' : 'Ctrl+P'
  // One key cap per key, as astryx's Kbd draws mod+p (spec §3 #236).
  const caps = apple ? ['⌘', 'P'] : ['Ctrl', 'P']
  return (
    <button
      type="button"
      class="pc-find"
      aria-label="세션 이동"
      aria-haspopup="dialog"
      aria-keyshortcuts={apple ? 'Meta+P' : 'Control+P'}
      title={`세션 이동 (${keys})`}
      onClick={openSwitcher}
    >
      <Icon name="search" size={16} />
      <span class="pc-find-text">세션 찾기 · 이동</span>
      <span class="kbd-group" aria-hidden="true">
        {caps.map((k) => (
          <kbd key={k} class="kbd">
            {k}
          </kbd>
        ))}
      </span>
    </button>
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
    <button type="button" class="btn btn-icon btn-sm btn-ghost" aria-label={label} title={`${label} · 누르면 ${THEME_LABEL[THEME_NEXT[t]]}`} onClick={() => setTheme(THEME_NEXT[t])}>
      <Icon name={THEME_ICON[t]} size={18} />
    </button>
  )
}

/* ---------- phone ---------- */

type Tab = 'queue' | 'folders' | 'settings'

const TAB_TITLE: Record<Tab, string> = { queue: '지금 볼 것', folders: '폴더', settings: '설정' }

const isTab = (name: Route['name']): name is Tab => name === 'queue' || name === 'folders' || name === 'settings'

function PhoneShell() {
  const h = useHost()
  const r = route.value
  const unlinked = h.problem.value === 'unlinked'
  const tab = isTab(r.name) ? r.name : null
  // A session of an unlinked host cannot open: back to its list, which says why.
  useEffect(() => {
    if (unlinked && !tab) h.go({ name: 'queue' }, { replace: true })
  }, [unlinked, tab])
  if (unlinked) {
    const t = tab ?? 'queue'
    return (
      <PhoneTab key={t} tab={t} title={TAB_TITLE[t]}>
        <HostProblem variant="phone" />
      </PhoneTab>
    )
  }
  switch (r.name) {
    case 'queue':
      return (
        <PhoneTab key="queue" tab="queue" title={TAB_TITLE.queue} fab>
          <QueueList variant="phone" />
        </PhoneTab>
      )
    case 'folders':
      return (
        <PhoneTab key="folders" tab="folders" title={TAB_TITLE.folders} fab>
          <FolderList variant="phone" />
        </PhoneTab>
      )
    case 'settings':
      return (
        <PhoneTab
          key="settings"
          tab="settings"
          title={TAB_TITLE.settings}
          sub={
            <>
              <b>{nameOf(h)}</b> · {settingsSub(h)}
            </>
          }
        >
          <Settings variant="phone" />
        </PhoneTab>
      )
    default: {
      const v = phoneFull(r, h)
      return <PhoneFull back={v?.back ?? h.href({ name: 'queue' })}>{v?.body}</PhoneFull>
    }
  }
}

/** A screen without the tab bar: a finger drawn rightwards goes where its ‹ goes (spec §3 #200). */
function PhoneFull({ back, children }: { back: string; children: ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null)
  const to = useRef(back)
  to.current = back
  useEffect(
    () =>
      backSwipe(ref.current!, {
        back: () => navigate(parseHash(to.current)),
        blocked: () => layersOpen() || !!document.querySelector('dialog[open]'),
      }),
    [],
  )
  return (
    <div ref={ref} class="ph ph-full">
      {children}
    </div>
  )
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
          {sub ? (
            <p class="ph-sub">{sub}</p>
          ) : (
            <div class="hostbar">
              <HostButton />
              <OthersBadge />
            </div>
          )}
        </div>
        {fab && (
          <a class="fab" href={h.href({ name: 'new' })} aria-label="새 세션">
            <Icon name="plus" size={24} stroke={2} />
          </a>
        )}
      </header>
      <ConnBanner class="ph-banner" list={tab !== 'settings'} />
      <div class="ph-scroll">{children}</div>
      <TabBar current={tab} />
      {!sub && <HostSheet />}
    </div>
  )
}

function TabBar({ current }: { current: Tab }) {
  const h = useHost()
  const n = h.needs.value
  const fresh = newBuild.value !== null
  const tab = (t: Tab, to: string, icon: IconName, label: string, extra?: ComponentChildren) => (
    <a class="tab" href={to} aria-current={current === t ? 'page' : undefined}>
      <span class="tab-icon">
        <Icon name={icon} size={22} />
        {extra}
      </span>
      {label}
      {t === 'queue' && n > 0 && <span class="sr-only">, 볼 것 {n}개</span>}
      {t === 'settings' && fresh && <span class="sr-only">, 새 버전이 있습니다</span>}
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
      {tab('settings', h.href({ name: 'settings' }), 'sliders', '설정', fresh && <span class="nav-dot" aria-hidden="true" />)}
    </nav>
  )
}
