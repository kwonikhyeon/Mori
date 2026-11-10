import { cleanup, fireEvent, render, screen, within } from '@testing-library/preact'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { folder, status, term } from '../../test/fixtures'
import { inHost, withHost } from '../../test/scopes'
import { now } from '../lib/clock'
import { folders, presets, ready, resetStore, terminals } from '../lib/store'
import type { TerminalView } from '../lib/types'
import { FolderList } from './Folders'
import { QueueList } from './Queue'

const NOW = 10 * 3_600_000

function load(ts: TerminalView[]) {
  terminals.value = new Map(ts.map((t) => [t.address, t]))
  ready.value = true
}

beforeEach(() => {
  now.value = NOW
  folders.value = [folder()]
  presets.value = [{ id: 'claude', name: 'Claude Code', argv: ['claude'], task: true }]
})

afterEach(() => {
  cleanup()
  resetStore()
})

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

  it('folds the quiet groups and says when nothing needs an answer', () => {
    load([
      term({ address: 't1', status: null }),
      term({ address: 't2', state: 'finished', reason: 'exited', exit_code: 0, finished_ms: NOW - 2 * 3_600_000, argv: [], preset: undefined }),
    ])
    render(<QueueList variant="phone" />)
    expect(screen.getByText('지금 응답할 세션이 없습니다')).toBeTruthy()
    const fold = screen.getByRole('button', { name: /최근 종료 1/ })
    expect(fold.getAttribute('aria-expanded')).toBe('false')
    expect(fold.textContent).toContain('셸 · 코드 0 · 2시간 전')
    expect(screen.queryByRole('link')).toBeNull()
    fireEvent.click(fold)
    expect(fold.getAttribute('aria-expanded')).toBe('true')
    const row = screen.getByRole('link')
    expect(row.getAttribute('href')).toBe('#/t/t2')
    expect(row.textContent).toContain('코드 0 · 2시간 전')
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
  it('lists every folder with its sessions and the rest under 기타', () => {
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
    const rows = within(mori).getAllByRole('listitem').map((li) => li.textContent)
    expect(rows[0]).toContain('Claude Code · main')
    expect(rows[1]).toContain('코드 1 · 1분 전')
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
