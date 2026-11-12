import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { folder, status, term } from '../../test/fixtures'
import { inHost, withHost } from '../../test/scopes'
import { closeContext, ContextMenuHost } from '../components/ContextMenu'
import { now } from '../lib/clock'
import { markSeen, resetSeen } from '../lib/seen'
import { folders, presets, ready, resetStore, terminals } from '../lib/store'
import type { TerminalView } from '../lib/types'
import { FolderList } from './Folders'
import { QueueList } from './Queue'

const NOW = 10 * 3_600_000
const MIN = 60_000

function load(ts: TerminalView[]) {
  terminals.value = new Map(ts.map((t) => [t.address, t]))
  ready.value = true
}

beforeEach(() => {
  localStorage.clear()
  resetSeen()
  now.value = NOW
  folders.value = [folder()]
  presets.value = [{ id: 'claude', name: 'Claude Code', argv: ['claude'], task: true }]
})

afterEach(() => {
  cleanup()
  resetStore()
  localStorage.clear()
  resetSeen()
})

/** The time on each link of a group, null where there is none. */
const times = (name: string) =>
  within(screen.getByRole('region', { name }))
    .getAllByRole('link')
    .map((a) => a.querySelector('time')?.textContent ?? null)

describe('QueueList', () => {
  it('waits for the first snapshot before saying anything is empty', () => {
    render(<QueueList variant="phone" />)
    expect(screen.getByRole('status').textContent).toBe('불러오는 중')
  })

  it('points at a new session when there is none', () => {
    load([])
    render(<QueueList variant="phone" />)
    expect(screen.getByText('아직 세션이 없습니다')).toBeTruthy()
    expect(screen.getByRole('link', { name: '새 세션' }).getAttribute('href')).toBe('#/new')
  })

  it('puts what waits for a person first, with counts', () => {
    load([
      term({ address: 't1', status: status('working', { progress: 40 }), status_ms: 5 }),
      term({ address: 't2', status: status('blocked', { kind: 'permission' }), display_title: '알림 정리' }),
      term({ address: 't3', status: status('idle') }),
      term({ address: 't4', status: status('error', { msg: '네트워크 오류로 중단됨' }) }),
    ])
    render(<QueueList variant="phone" />)
    const titles = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    expect(titles).toEqual(['승인 대기 1', '오류 1', '입력 대기 1', '작업 중 1'])
    const blocked = screen.getByRole('region', { name: '승인 대기 1' })
    const card = within(blocked).getByRole('link')
    expect(card.getAttribute('href')).toBe('#/t/t2')
    expect(card.textContent).toContain('알림 정리')
    expect(card.textContent).toContain('Mori / main')
    expect(card.textContent).toContain('실행 허가를 기다립니다')
    expect(card.textContent).toContain('열어서 키로 응답')
    expect(within(screen.getByRole('region', { name: '오류 1' })).getByRole('link').textContent).toContain('네트워크 오류로 중단됨')
    expect(within(screen.getByRole('region', { name: '작업 중 1' })).getByRole('link').textContent).toContain('작업 중 40%')
  })

  it('marks the open terminal and keeps the Git aside open on PC', () => {
    load([term({ address: 't1', status: status('blocked') }), term({ address: 't2', status: status('idle') })])
    render(<QueueList variant="pc" selected="t1" git />)
    const links = screen.getAllByRole('link')
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['#/t/t1/git', '#/t/t2/git'])
    expect(links[0].getAttribute('aria-current')).toBe('true')
    expect(links[0].textContent).toContain('보는 중')
    expect(links[1].getAttribute('aria-current')).toBeNull()
  })

  // a finished session is not listed, however recent (spec §3 #229)
  it('folds the quiet groups, leaves finished sessions out and says when nothing needs an answer', () => {
    load([
      term({ address: 't1', status: null }),
      term({ address: 't2', state: 'finished', reason: 'exited', exit_code: 0, finished_ms: NOW - 60_000, argv: [], preset: undefined }),
    ])
    render(<QueueList variant="phone" />)
    expect(screen.getByText('지금 응답할 세션이 없습니다')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /최근 종료/ })).toBeNull()
    const fold = screen.getByRole('button', { name: /상태 없음 1/ })
    expect(fold.getAttribute('aria-expanded')).toBe('false')
    expect(fold.textContent).toContain('상태를 보고하지 않는 프로그램')
    expect(screen.queryByRole('link')).toBeNull()
    fireEvent.click(fold)
    expect(fold.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['#/t/t1'])
  })

  it('tells how long each has worked, asked or waited', () => {
    load([
      term({ address: 't1', status: status('working'), status_ms: NOW - 12 * MIN }),
      term({ address: 't2', status: status('blocked', { kind: 'permission' }), status_ms: NOW - 30_000 }),
      term({ address: 't3', status: status('idle'), status_ms: NOW - 3 * MIN }),
      term({ address: 't4', status: status('idle') }),
    ])
    render(<QueueList variant="pc" />)
    expect(times('작업 중 1')).toEqual(['12분째'])
    expect(times('승인 대기 1')).toEqual(['방금'])
    expect(times('입력 대기 2')).toEqual(['3분 전', null])
    const work = within(screen.getByRole('region', { name: '작업 중 1' })).getByRole('link').querySelector('time')!
    expect(work.getAttribute('title')).toMatch(/^오늘 \d\d:\d\d부터 작업 중$/)
    expect(work.getAttribute('dateTime')).toBe(new Date(NOW - 12 * MIN).toISOString())
  })

  it('marks a finish not opened here yet, until it is', () => {
    const done = term({ address: 't1', status: status('done'), status_ms: NOW - 5 * MIN, turn: 3, display_title: '빌드' })
    load([done, term({ address: 't2', status: status('idle'), status_ms: NOW - 9 * MIN, display_title: '셸' })])
    render(<QueueList variant="phone" />)
    const [fresh, quiet] = within(screen.getByRole('region', { name: '입력 대기 2' })).getAllByRole('link')
    expect(fresh.classList.contains('is-unseen')).toBe(true)
    expect(fresh.querySelector('.qrow-dot')).toBeTruthy()
    expect(fresh.textContent).toContain('빌드 · 새 결과')
    expect(quiet.classList.contains('is-unseen')).toBe(false)
    act(() => markSeen('', done, NOW))
    expect(fresh.classList.contains('is-unseen')).toBe(false)
    expect(fresh.textContent).not.toContain('새 결과')
    act(() => {
      terminals.value = new Map([['t1', { ...done, turn: 4, status_ms: NOW - MIN }]])
    })
    expect(screen.getByRole('link').textContent).toContain('새 결과')
  })
})

describe('QueueList on another host', () => {
  it("links that host's sessions", () => {
    const s = withHost()
    s.terminals.value = new Map([['t1', term({ status: status('blocked', { kind: 'permission' }) })]])
    s.ready.value = true
    render(inHost(s, <QueueList variant="pc" />))
    const blocked = screen.getByRole('region', { name: '승인 대기 1' })
    expect(within(blocked).getByRole('link').getAttribute('href')).toBe('#/h/h_desk0001/t/t1')
  })

  it("keeps that host's seen finishes apart", () => {
    const s = withHost()
    const done = term({ status: status('done'), status_ms: NOW - 5 * MIN, turn: 1 })
    s.terminals.value = new Map([['t1', done]])
    s.ready.value = true
    render(inHost(s, <QueueList variant="pc" />))
    const row = () => within(screen.getByRole('region', { name: '입력 대기 1' })).getByRole('link')
    act(() => markSeen('', done, NOW))
    expect(row().classList.contains('is-unseen')).toBe(true)
    act(() => markSeen('h_desk0001', done, NOW))
    expect(row().classList.contains('is-unseen')).toBe(false)
  })

  it('points at a new session on that host', () => {
    const s = withHost()
    s.ready.value = true
    render(inHost(s, <QueueList variant="phone" />))
    expect(screen.getByRole('link', { name: '새 세션' }).getAttribute('href')).toBe('#/h/h_desk0001/new')
  })

  it("greys a host's list that may be stale", () => {
    const s = withHost()
    s.ready.value = true
    s.unreachable.value = true
    render(inHost(s, <QueueList variant="pc" />))
    const qv = document.querySelector('.qv')!
    expect(qv.getAttribute('aria-disabled')).toBe('true')
    expect(qv.classList.contains('is-stale')).toBe(true)
  })

  it("keeps a stale list's sessions from opening", () => {
    const s = withHost()
    s.terminals.value = new Map([['t1', term({ status: status('blocked', { kind: 'permission' }) })]])
    s.ready.value = true
    s.unreachable.value = true
    render(inHost(s, <QueueList variant="pc" />))
    const link = within(screen.getByRole('region', { name: '승인 대기 1' })).getByRole('link')
    expect(fireEvent.click(link)).toBe(false)
  })
})

describe('FolderList', () => {
  it('lists every folder with its live sessions and the rest under 기타', () => {
    folders.value = [folder(), folder({ id: 'f2', name: 'Notes', path: '/Users/me/notes', repo: false, worktrees: [] })]
    load([
      term({ address: 't1', status: status('idle'), created_ms: 1 }),
      term({ address: 't2', state: 'finished', reason: 'exited', exit_code: 1, finished_ms: NOW - 60_000, created_ms: 9 }),
      term({ address: 'desk/t3', folder_id: '', cwd: '/home/me/x', created_ms: 5 }),
    ])
    render(<FolderList variant="pc" />)
    const mori = screen.getByRole('region', { name: 'Mori' })
    expect(within(mori).getByText('~/dev/Mori')).toBeTruthy()
    expect(within(mori).getByRole('link', { name: 'Mori Git 보기' }).getAttribute('href')).toBe('#/git/f1')
    expect(within(mori).getByRole('link', { name: 'Mori에서 새 세션' }).getAttribute('href')).toBe('#/new?folder=f1')
    // the finished t2 is not listed (spec §3 #229)
    const rows = within(mori).getAllByRole('listitem').map((li) => li.textContent)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain('Claude Code · main')
    const notes = screen.getByRole('region', { name: 'Notes' })
    expect(within(notes).queryByRole('link', { name: /Git/ })).toBeNull()
    expect(within(notes).getByText('세션 없음')).toBeTruthy()
    const rest = screen.getByRole('region', { name: '기타' })
    expect(within(rest).getByRole('link').textContent).toContain('desk · ~/x')
  })

  it("greys a host's folders that may be stale", () => {
    const s = withHost()
    s.ready.value = true
    s.unreachable.value = true
    render(inHost(s, <FolderList variant="pc" />))
    const fv = document.querySelector('.fv')!
    expect(fv.getAttribute('aria-disabled')).toBe('true')
    expect(fv.classList.contains('is-stale')).toBe(true)
  })

  it("keeps a stale host's folders from opening", () => {
    const s = withHost()
    s.folders.value = [folder()]
    s.terminals.value = new Map([['t1', term()]])
    s.ready.value = true
    s.unreachable.value = true
    render(inHost(s, <FolderList variant="pc" />))
    const mori = screen.getByRole('region', { name: 'Mori' })
    expect(fireEvent.click(within(mori).getByRole('link', { name: 'Mori Git 보기' }))).toBe(false)
    expect(fireEvent.click(within(within(mori).getByRole('list')).getByRole('link'))).toBe(false)
  })
})

describe('a session row\'s context menu (spec §3 #242)', () => {
  let calls: { method: string; url: string; body: unknown }[] = []
  beforeEach(() => {
    calls = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push({ method: init.method ?? 'GET', url: String(url), body: init.body ? JSON.parse(String(init.body)) : undefined })
        return Response.json({})
      }),
    )
  })
  afterEach(() => {
    act(() => closeContext())
    vi.unstubAllGlobals()
  })

  const open = (name: RegExp) => {
    render(
      <>
        <FolderList variant="pc" />
        <ContextMenuHost />
      </>,
    )
    fireEvent.contextMenu(screen.getByRole('link', { name }), { button: 2, clientX: 10, clientY: 10 })
    return screen.getByRole('menu')
  }
  const names = (m: HTMLElement) => [...m.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent)

  it('offers what is done to a live session, ending it after asking', async () => {
    load([term({ address: 't1', display_title: '알림 정리', status: status('working') })])
    const m = open(/알림 정리/)
    expect(m.getAttribute('aria-label')).toBe('알림 정리')
    expect(names(m)).toEqual(['열기', '새 창에서 열기', '이름 바꾸기', '작업 폴더 경로 복사', '중단', '종료'])
    fireEvent.click(screen.getByRole('menuitem', { name: '종료' }))
    fireEvent.click(screen.getByRole('button', { name: '종료' }))
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/terminals/t1/kill')).toBe(true))
  })

  it('renames in the row: Enter keeps the name, Escape does not', async () => {
    load([term({ address: 't1', display_title: '알림 정리', status: status('idle') })])
    open(/알림 정리/)
    fireEvent.click(screen.getByRole('menuitem', { name: '이름 바꾸기' }))
    const field = screen.getByRole('textbox', { name: '세션 이름' })
    expect(document.activeElement).toBe(field)
    fireEvent.input(field, { target: { value: '새 이름' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await vi.waitFor(() => expect(calls).toContainEqual({ method: 'PATCH', url: '/api/terminals/t1', body: { title: '새 이름' } }))
    expect(screen.queryByRole('textbox', { name: '세션 이름' })).toBeNull()
  })
})
