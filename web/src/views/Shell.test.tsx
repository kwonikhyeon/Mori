import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeWebSocket } from '../../test/fakeWs'
import { folder, status, term } from '../../test/fixtures'
import { COMMITS, diffOf, LOG } from '../../test/history'
import { hello } from '../lib/boot'
import { now } from '../lib/clock'
import { viewportWidth } from '../lib/media'
import { href, route, type Route } from '../lib/router'
import { conn, core, folders, hosts, ready, resetStore, terminals } from '../lib/store'
import { theme } from '../lib/theme'
import type { TerminalView } from '../lib/types'
import { gitFrom } from './Git'
import { phoneBack, Shell } from './Shell'
import { forgetCommits } from './useLog'

// jsdom cannot lay out xterm's cells.
vi.mock('../lib/xterm', async () => {
  const { FakeScreen } = await import('../../test/fakeScreen')
  return { openScreen: vi.fn(async () => new FakeScreen()) }
})

function load(ts: TerminalView[]) {
  terminals.value = new Map(ts.map((t) => [t.address, t]))
  ready.value = true
}

function at(width: number, r: Route) {
  viewportWidth.value = width
  route.value = r
}

const sidebar = () => screen.getByRole('separator', { name: '사이드바 너비' })

/** A server whose worktrees have nothing changed. */
function cleanRepo() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (u: string) => {
      const path = new URL(u, 'http://mori.test').pathname
      if (path === '/api/git/status') return Response.json({ head: 'a'.repeat(40), branch: 'main', detached: false, upstream: '', ahead: 0, behind: 0, changes: [] })
      return Response.json({})
    }),
  )
}

/** A server with the history of test/history.ts. */
function withHistory() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (u: string) => {
      const q = new URL(u, 'http://mori.test')
      if (q.pathname === '/api/git/log') return Response.json(LOG)
      if (q.pathname === '/api/git/commit') return Response.json(COMMITS[q.searchParams.get('rev')!])
      if (q.pathname === '/api/git/diff') return Response.json({ diff: diffOf(q.searchParams.get('file')!), truncated: false })
      return Response.json({})
    }),
  )
}

beforeEach(() => {
  FakeWebSocket.reset()
  vi.stubGlobal('WebSocket', FakeWebSocket)
  localStorage.clear()
  history.replaceState(null, '', '/#/')
  now.value = 10 * 3_600_000
  folders.value = [folder()]
  hello.value = { app: 'mori', version: '0.1.0', host: 'macmini', paired: true }
  conn.value = 'open'
  core.value = { connected: true }
})

afterEach(() => {
  cleanup()
  resetStore()
  hello.value = null
  theme.value = 'system'
  route.value = { name: 'queue' }
  phoneBack.value = '#/'
  gitFrom.value = ''
  forgetCommits()
  vi.unstubAllGlobals()
})

describe('PC', () => {
  it('draws the sidebar at its default width and widens it from the keyboard', () => {
    at(1440, { name: 'queue' })
    render(<Shell />)
    const side = screen.getByRole('navigation', { name: '세션 대기열' })
    expect(side.style.width).toBe('380px')
    const h = sidebar()
    expect(h.getAttribute('aria-controls')).toBe('pc-side')
    expect(h.getAttribute('aria-valuemin')).toBe('280')
    expect(h.getAttribute('aria-valuemax')).toBe('560')
    fireEvent.keyDown(h, { key: 'ArrowRight' })
    expect(side.style.width).toBe('396px')
    expect(localStorage.getItem('mori.sidebar')).toBe('396')
    fireEvent.dblClick(h)
    expect(side.style.width).toBe('380px')
    expect(localStorage.getItem('mori.sidebar')).toBe('380')
  })

  it('narrows the drawn sidebar for a small window but keeps the saved width', () => {
    localStorage.setItem('mori.sidebar', '560')
    at(1000, { name: 'queue' })
    render(<Shell />)
    // 1000 - 48 for the padding and the gap - 420 for the main area
    expect(screen.getByRole('navigation', { name: '세션 대기열' }).style.width).toBe('532px')
    expect(sidebar().getAttribute('aria-valuemax')).toBe('532')
    expect(localStorage.getItem('mori.sidebar')).toBe('560')
  })

  it('switches the list, and the route only while nothing is open', () => {
    load([])
    at(1440, { name: 'queue' })
    render(<Shell />)
    expect(screen.getByText('세션을 고르세요')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '폴더' }))
    expect(route.value).toEqual({ name: 'folders' })
    expect(location.hash).toBe('#/folders')
    expect(screen.getByRole('region', { name: /Mori/ })).toBeTruthy()

    route.value = { name: 'terminal', addr: 't1', git: false }
    fireEvent.click(screen.getByRole('button', { name: /지금 볼 것/ }))
    expect(route.value).toEqual({ name: 'terminal', addr: 't1', git: false })
  })

  it('keeps the Git aside open while picking another session', () => {
    load([term({ address: 't1', status: status('idle') }), term({ address: 't2', status: status('idle'), display_title: '둘째' })])
    at(1440, { name: 'terminal', addr: 't1', git: true })
    render(<Shell />)
    expect(within(screen.getByRole('main')).getByRole('heading', { level: 1, name: 'Claude Code' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Git' }).getAttribute('aria-pressed')).toBe('true')
    const aside = screen.getByRole('complementary', { name: 'Git' })
    expect(aside.classList.contains('is-over')).toBe(false)
    expect(aside.style.width).toBe('360px')
    const h = screen.getByRole('separator', { name: 'Git 패널 너비' })
    // the handle is on the aside's left: ArrowLeft widens it
    fireEvent.keyDown(h, { key: 'ArrowLeft' })
    expect(aside.style.width).toBe('376px')
    expect(localStorage.getItem('mori.aside')).toBe('376')
    const links = within(screen.getByRole('navigation', { name: '세션 대기열' })).getAllByRole('link')
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['#/t/t1/git', '#/t/t2/git'])
  })

  it("shows the session's Git beside it and closes it", async () => {
    cleanRepo()
    load([term({ address: 't1', status: status('idle') })])
    at(1440, { name: 'terminal', addr: 't1', git: true })
    render(<Shell />)
    const aside = screen.getByRole('complementary', { name: 'Git' })
    expect(await within(aside).findByRole('region', { name: '변경 0' })).toBeTruthy()
    expect(within(aside).getByText('이 세션')).toBeTruthy()
    fireEvent.click(within(aside).getByRole('button', { name: 'Git 닫기' }))
    expect(route.value).toEqual({ name: 'terminal', addr: 't1', git: false })
    expect(screen.queryByRole('complementary')).toBeNull()
  })

  it('lays the aside over the main area in a narrow window', () => {
    at(1000, { name: 'terminal', addr: 't1', git: true })
    render(<Shell />)
    expect(screen.getByRole('complementary', { name: 'Git' }).classList.contains('is-over')).toBe(true)
    expect(screen.getByRole('separator', { name: 'Git 패널 너비' }).classList.contains('splitter-over')).toBe(true)
  })

  it('shows the commit picked in the graph beside it and closes it', async () => {
    withHistory()
    load([])
    at(1440, { name: 'graph', folder: 'f1', head: false })
    render(<Shell />)
    expect(screen.getByRole('heading', { level: 1, name: 'Git 그래프' })).toBeTruthy()
    const rows = await screen.findByRole('list', { name: '커밋' })
    expect(screen.queryByRole('complementary')).toBeNull()
    fireEvent.click(within(rows).getByRole('link', { name: /bbbbbbb/ }))
    const aside = screen.getByRole('complementary', { name: '커밋' })
    expect(aside.style.width).toBe('360px')
    expect(screen.getByRole('separator', { name: '커밋 패널 너비' }).getAttribute('aria-controls')).toBe('pc-aside')
    expect(await within(aside).findByRole('heading', { level: 3, name: '알림이 두 번 뜨던 문제 고침' })).toBeTruthy()
    // The parent's subject comes from the graph's log.
    expect(within(aside).getByText('처음')).toBeTruthy()
    fireEvent.click(within(aside).getByRole('button', { name: '커밋 닫기' }))
    expect(route.value).toEqual({ name: 'graph', folder: 'f1', head: false })
    expect(screen.queryByRole('complementary')).toBeNull()
  })

  it('says how the host is and links the other hosts', () => {
    hosts.value = [
      { name: 'desk', url: 'https://desk.example.ts.net' },
      { name: 'self', url: location.origin },
    ]
    core.value = { connected: false }
    at(1440, { name: 'queue' })
    render(<Shell />)
    const nav = screen.getByRole('navigation', { name: '호스트' })
    expect(nav.textContent).toContain('macmini')
    expect(nav.textContent).toContain('코어 연결 중')
    expect(within(nav).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['https://desk.example.ts.net'])
  })

  it('cycles the theme from the header', () => {
    at(1440, { name: 'queue' })
    render(<Shell />)
    const b = screen.getByRole('button', { name: '화면 테마: 시스템' })
    fireEvent.click(b)
    expect(theme.value).toBe('light')
    expect(localStorage.getItem('mori.theme')).toBe('"light"')
    fireEvent.click(screen.getByRole('button', { name: '화면 테마: 밝게' }))
    expect(theme.value).toBe('dark')
    fireEvent.click(screen.getByRole('button', { name: '화면 테마: 어둡게' }))
    expect(theme.value).toBe('system')
  })
})

describe('phone', () => {
  it('shows the tab bar with what waits for a person', () => {
    load([term({ address: 't1', status: status('blocked', { kind: 'permission' }) }), term({ address: 't2', status: status('working') })])
    at(390, { name: 'queue' })
    render(<Shell />)
    expect(screen.queryByRole('separator')).toBeNull()
    const bar = screen.getByRole('navigation', { name: '주 메뉴' })
    const tabs = within(bar).getAllByRole('link')
    expect(tabs.map((a) => a.getAttribute('href'))).toEqual(['#/', '#/folders', '#/settings'])
    expect(tabs[0].getAttribute('aria-current')).toBe('page')
    expect(tabs[0].textContent).toContain('볼 것 1개')
    expect(screen.getByRole('link', { name: '새 세션' }).getAttribute('href')).toBe('#/new')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('지금 볼 것')
  })

  it('opens the host menu and closes it with Escape', () => {
    at(390, { name: 'folders' })
    render(<Shell />)
    const btn = screen.getByRole('button', { name: /macmini/ })
    expect(btn.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(btn)
    expect(btn.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('다른 호스트')).toBeTruthy()
    const pop = document.getElementById(btn.getAttribute('aria-controls')!)!
    expect(within(pop).getByRole('link', { name: '설정' }).getAttribute('href')).toBe('#/settings')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(btn.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(btn)
  })

  it('gives a session the whole screen', () => {
    at(390, { name: 'terminal', addr: 't1', git: false })
    render(<Shell />)
    expect(screen.queryByRole('navigation', { name: '주 메뉴' })).toBeNull()
    expect(screen.getByRole('link', { name: '뒤로' }).getAttribute('href')).toBe('#/')
  })

  it('goes back from Git to where it was opened', async () => {
    cleanRepo()
    load([term({ address: 't1', status: status('idle') })])
    at(390, { name: 'terminal', addr: 't1', git: false })
    render(<Shell />)
    const link = screen.getByRole('link', { name: 'Git' })
    expect(link.getAttribute('href')).toBe('#/git/f1?path=%2FUsers%2Fme%2Fdev%2FMori')
    fireEvent.click(link)
    await act(() => {
      route.value = { name: 'git', folder: 'f1', path: '/Users/me/dev/Mori' }
    })
    expect(screen.getByRole('link', { name: '뒤로' }).getAttribute('href')).toBe('#/t/t1')
    expect(await screen.findByText('이 세션')).toBeTruthy()

    await act(() => {
      route.value = { name: 'folders' }
    })
    await act(() => {
      route.value = { name: 'git', folder: 'f1' }
    })
    expect(screen.getByRole('link', { name: '뒤로' }).getAttribute('href')).toBe('#/folders')
    expect(screen.queryByText('이 세션')).toBeNull()
  })

  it('gives the graph the whole screen and its commit a sheet', async () => {
    withHistory()
    load([])
    at(390, { name: 'graph', folder: 'f1', head: false, c: 'b'.repeat(40) })
    render(<Shell />)
    expect(screen.queryByRole('navigation', { name: '주 메뉴' })).toBeNull()
    expect(screen.getByRole('link', { name: '뒤로' }).getAttribute('href')).toBe(href({ name: 'git', folder: 'f1' }))
    const sheet = screen.getByRole('region', { name: '커밋' })
    expect(await within(sheet).findByRole('heading', { name: '알림이 두 번 뜨던 문제 고침' })).toBeTruthy()
    expect(screen.queryByRole('complementary')).toBeNull()
  })

  it('goes back from a session to the tab it was opened from', async () => {
    load([term({ address: 't1', status: status('idle') })])
    at(390, { name: 'folders' })
    render(<Shell />)
    await act(() => {
      route.value = { name: 'terminal', addr: 't1', git: false }
    })
    expect(screen.getByRole('heading', { level: 1, name: 'Claude Code' })).toBeTruthy()
    expect(screen.getByRole('link', { name: '뒤로' }).getAttribute('href')).toBe('#/folders')
  })
})
