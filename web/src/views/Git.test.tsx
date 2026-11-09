import { cleanup, fireEvent, render, screen, within } from '@testing-library/preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { folder, term, worktree } from '../../test/fixtures'
import { href, route } from '../lib/router'
import { folders, ready, resetStore, terminals } from '../lib/store'
import { toasts } from '../lib/toast'
import type { Branches, GitStatus } from '../lib/types'
import { GitPanel, GitScreen, gitFrom } from './Git'

interface Call {
  method: string
  url: string
  body: unknown
}

type Reply = Response | Promise<Response> | undefined

let calls: Call[] = []
let reply: (c: Call) => Reply = () => undefined

const MAIN = '/Users/me/dev/Mori'
const WT = '/Users/me/dev/Mori.wt/fix-notify'
const MADE = '/Users/me/dev/Mori.wt/fix-x'

const repo = () => folder({ worktrees: [worktree(), worktree({ path: WT, branch: 'fix/notify', main: false, head: 'b'.repeat(40) })] })

const status = (over: Partial<GitStatus> = {}): GitStatus => ({
  head: 'a'.repeat(40),
  branch: 'main',
  detached: false,
  upstream: 'origin/main',
  ahead: 2,
  behind: 0,
  changes: [
    { path: 'internal/push/notify.go', index: 'M', worktree: 'M', kind: 'changed' },
    { path: 'docs/new.md', orig: 'docs/old.md', index: 'R', worktree: '.', kind: 'renamed' },
    { path: 'web/', index: '?', worktree: '?', kind: 'untracked' },
    { path: 'a.txt', index: 'U', worktree: 'U', kind: 'unmerged' },
  ],
  ...over,
})

const BRANCHES: Branches = {
  local: [
    { name: 'main', head: 'a', current: true, remote: false },
    { name: 'fix/notify', head: 'b', current: false, remote: false },
  ],
  remote: [],
}

const diffOf = (file: string, staged: boolean) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-${staged ? 'staged' : 'old'}\n+new\n`

const url = (c: Call) => new URL(c.url, 'http://mori.test')
const statusCalls = () => calls.filter((c) => url(c).pathname === '/api/git/status').map((c) => url(c).searchParams.get('path'))
const diffCalls = () => calls.filter((c) => url(c).pathname === '/api/git/diff').map((c) => Object.fromEntries(url(c).searchParams))
const deletes = () => calls.filter((c) => c.method === 'DELETE').map((c) => Object.fromEntries(url(c).searchParams))
const region = (name: string | RegExp) => screen.getByRole('region', { name })
const toastTexts = () => toasts.value.map((t) => [t.text, t.kind])

function serve(over: (c: Call) => Reply = () => undefined) {
  reply = (c) => {
    const o = over(c)
    if (o) return o
    const u = url(c)
    if (u.pathname === '/api/git/status') return Response.json(status())
    if (u.pathname === '/api/git/diff') return Response.json({ diff: diffOf(u.searchParams.get('file')!, u.searchParams.has('staged')), truncated: false })
    if (u.pathname === '/api/folders/f1/branches') return Response.json(BRANCHES)
    return undefined
  }
}

const fail = (status: number, kind: string, message: string) => Response.json({ error: { kind, message } }, { status })

const panel = (over: Partial<Parameters<typeof GitPanel>[0]> = {}) => <GitPanel folder="f1" path={MAIN} onClose={() => {}} {...over} />

beforeEach(() => {
  calls = []
  reply = () => undefined
  vi.stubGlobal(
    'fetch',
    vi.fn(async (u: string, init: RequestInit = {}) => {
      const raw = init.body
      const c = { method: init.method ?? 'GET', url: String(u), body: typeof raw === 'string' ? JSON.parse(raw) : undefined }
      calls.push(c)
      return (await reply(c)) ?? Response.json({})
    }),
  )
  folders.value = [repo()]
  terminals.value = new Map([term({ address: 't1', worktree: MAIN }), term({ address: 't3', worktree: WT })].map((t) => [t.address, t]))
  ready.value = true
  toasts.value = []
  gitFrom.value = ''
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  resetStore()
  toasts.value = []
  gitFrom.value = ''
  route.value = { name: 'queue' }
  history.replaceState(null, '', '/')
  vi.unstubAllGlobals()
})

describe('GitPanel', () => {
  it('lists the changes by group and shows the first beside them', async () => {
    serve()
    const close = vi.fn()
    render(panel({ onClose: close }))
    const changes = await screen.findByRole('region', { name: '변경 4' })
    expect(within(changes).getAllByRole('heading', { level: 4 }).map((h) => h.textContent)).toEqual(['충돌', '스테이징됨', '변경', '추적 안 함'])
    expect(within(changes).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'U충돌 a.txt 양쪽에서 수정',
      'M수정 notify.go internal/push',
      'R이름 바꿈 new.md docs · docs/old.md에서 옮김',
      'M수정 notify.go internal/push',
      '?추적 안 함 web/ 새 폴더',
    ])

    const conflict = screen.getByRole('button', { name: '충돌 a.txt 양쪽에서 수정' })
    expect(conflict.getAttribute('aria-current')).toBe('true')
    await within(region('a.txt 변경 내용')).findByText('-old')
    expect(diffCalls()).toEqual([{ path: MAIN, file: 'a.txt' }])
    expect(region('a.txt 변경 내용').textContent).toContain('+1 −1')

    const [staged, changed] = within(changes).getAllByRole('button', { name: '수정 notify.go internal/push' })
    fireEvent.click(staged)
    expect(staged.getAttribute('aria-current')).toBe('true')
    expect(conflict.getAttribute('aria-current')).toBeNull()
    await within(region('notify.go 변경 내용')).findByText('-staged')
    fireEvent.click(changed)
    await within(region('notify.go 변경 내용')).findByText('-old')
    fireEvent.click(screen.getByRole('button', { name: /^이름 바꿈 new\.md/ }))
    await vi.waitFor(() =>
      expect(diffCalls().slice(1)).toEqual([
        { path: MAIN, file: 'internal/push/notify.go', staged: '1' },
        { path: MAIN, file: 'internal/push/notify.go' },
        { path: MAIN, file: 'docs/new.md', orig: 'docs/old.md', staged: '1' },
      ]),
    )

    const branch = region('브랜치')
    expect(branch.textContent).toContain('main')
    expect(branch.textContent).toContain('원격보다 2개 앞섬 · 보기만 합니다')
    expect(within(branch).getByText('↑2 ↓0').getAttribute('title')).toBe('origin/main')
    expect(within(branch).getByRole('link', { name: '그래프' }).getAttribute('href')).toBe(href({ name: 'graph', folder: 'f1', path: MAIN, head: false }))
    fireEvent.click(screen.getByRole('button', { name: 'Git 닫기' }))
    expect(close).toHaveBeenCalledOnce()
  })

  it('keeps the diff on screen while it reads it again', async () => {
    let hold: ((r: Response) => void) | undefined
    serve((c) => (url(c).pathname === '/api/git/diff' && diffCalls().length > 1 ? new Promise<Response>((r) => (hold = r)) : undefined))
    render(panel())
    await screen.findByText('-old')
    fireEvent.click(screen.getByRole('button', { name: '새로 고침' }))
    await vi.waitFor(() => expect(hold).toBeDefined())
    expect(screen.getByText('-old')).toBeTruthy()
    expect(screen.queryByText('불러오는 중')).toBeNull()
    hold!(Response.json({ diff: diffOf('a.txt', false).replace('-old', '-older'), truncated: false }))
    await screen.findByText('-older')
  })

  it('keeps what it shows when the server cannot be reached', async () => {
    let down = false
    serve((c) => (down && url(c).pathname.startsWith('/api/git/') ? Promise.reject(new TypeError('Failed to fetch')) : undefined))
    render(panel())
    await screen.findByText('-old')
    down = true
    fireEvent.click(screen.getByRole('button', { name: '새로 고침' }))
    await vi.waitFor(() => expect(statusCalls()).toHaveLength(2))
    await new Promise((r) => setTimeout(r, 10))
    expect(screen.getByText('-old')).toBeTruthy()
    expect(screen.getByRole('region', { name: '변경 4' })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('says why the changes could not be read, and when there are none', async () => {
    serve((c) => (url(c).pathname === '/api/git/status' ? fail(422, 'git_failed', 'fatal: bad object') : undefined))
    render(panel())
    expect((await screen.findByRole('alert')).textContent).toBe('fatal: bad object')
    cleanup()

    serve((c) => (url(c).pathname === '/api/git/status' ? Response.json(status({ changes: [], ahead: 0 })) : undefined))
    render(panel())
    await screen.findByText('작업 트리가 깨끗합니다')
    expect(region('변경 0')).toBeTruthy()
    expect(screen.queryByRole('region', { name: /변경 내용$/ })).toBeNull()
    expect(region('브랜치').textContent).toContain('원격과 같음')
    expect(diffCalls()).toEqual([])
  })

  it('reads the changes again every 10 seconds, when the session changes and on 새로 고침', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    serve()
    const { rerender } = render(panel({ pulse: 1 }))
    await vi.advanceTimersByTimeAsync(0)
    expect(statusCalls()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(statusCalls()).toHaveLength(2)
    // Not twice within two seconds, but not forgotten either.
    rerender(panel({ pulse: 2 }))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(statusCalls()).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(statusCalls()).toHaveLength(3)
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(2_000)
    expect(statusCalls()).toHaveLength(4)
    fireEvent.click(screen.getByRole('button', { name: '새로 고침' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(statusCalls()).toHaveLength(5)
    // Each read asks the server to list the worktrees again too.
    expect(calls.filter((c) => c.url === '/api/folders/f1/git')).toHaveLength(5)
  })

  it('shows another worktree in the panel and marks the session’s own', async () => {
    serve()
    render(panel({ path: WT }))
    const wts = await screen.findByRole('region', { name: '워크트리 2' })
    const fix = within(wts).getByRole('button', { name: /^fix\/notify ~/ })
    expect(fix.getAttribute('aria-current')).toBe('true')
    expect(fix.textContent).toContain('이 세션')
    expect(fix.textContent).toContain('세션 1')
    await vi.waitFor(() => expect(statusCalls()).toEqual([WT]))
    fireEvent.click(within(wts).getByRole('button', { name: /^main ~/ }))
    await vi.waitFor(() => expect(statusCalls()).toEqual([WT, MAIN]))
    expect(within(wts).getByRole('button', { name: /^main ~/ }).getAttribute('aria-current')).toBe('true')
    expect(route.value).toEqual({ name: 'queue' })
  })

  it('removes a worktree after asking', async () => {
    serve((c) => (c.method === 'DELETE' ? new Response(null, { status: 204 }) : undefined))
    render(panel())
    const wts = await screen.findByRole('region', { name: '워크트리 2' })
    // Not the main one.
    fireEvent.click(within(wts).getByRole('button', { name: 'main 워크트리 메뉴' }))
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['이 워크트리에서 새 세션'])
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })

    fireEvent.click(within(wts).getByRole('button', { name: 'fix/notify 워크트리 메뉴' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '워크트리 삭제' }))
    const dlg = screen.getByRole('dialog', { name: '워크트리를 삭제할까요?' })
    expect(within(dlg).getByText('~/dev/Mori.wt/fix-notify 폴더를 지웁니다. 브랜치는 지우지 않습니다.')).toBeTruthy()
    fireEvent.click(within(dlg).getByRole('button', { name: '삭제' }))
    await vi.waitFor(() => expect(toastTexts()).toEqual([['워크트리를 삭제했습니다', 'info']]))
    expect(deletes()).toEqual([{ path: WT }])
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('asks again before it removes a worktree git would keep', async () => {
    const msg = "fatal: '/Users/me/dev/Mori.wt/fix-notify' contains modified or untracked files, use --force to delete it"
    serve((c) => (c.method !== 'DELETE' ? undefined : url(c).searchParams.has('force') ? new Response(null, { status: 204 }) : fail(422, 'git_failed', msg)))
    render(panel())
    fireEvent.click(await screen.findByRole('button', { name: 'fix/notify 워크트리 메뉴' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '워크트리 삭제' }))
    const first = within(screen.getByRole('dialog')).getByRole('button', { name: '삭제' })
    first.focus()
    fireEvent.click(first)
    const dlg = await screen.findByRole('dialog', { name: '강제로 삭제할까요?' })
    expect(within(dlg).getByText(/contains modified or untracked files/).textContent).toContain('커밋하지 않은 변경과 추적하지 않는 파일도 함께 지워집니다')
    // A second press of the same key does not force it.
    expect(document.activeElement).toBe(within(dlg).getByRole('button', { name: '취소' }))
    fireEvent.click(within(dlg).getByRole('button', { name: '강제로 삭제' }))
    await vi.waitFor(() => expect(toastTexts()).toEqual([['워크트리를 삭제했습니다', 'info']]))
    expect(deletes()).toEqual([{ path: WT }, { path: WT, force: '1' }])
  })

  it('says why a worktree in use stays', async () => {
    serve((c) => (c.method === 'DELETE' ? fail(409, 'live', '이 워크트리에서 실행 중인 세션이 있습니다: Claude Code') : undefined))
    render(panel())
    fireEvent.click(await screen.findByRole('button', { name: 'fix/notify 워크트리 메뉴' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '워크트리 삭제' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '삭제' }))
    await vi.waitFor(() => expect(toastTexts()).toEqual([['이 워크트리에서 실행 중인 세션이 있습니다: Claude Code', 'error']]))
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(deletes()).toEqual([{ path: WT }])
  })

  it('makes a worktree and shows it', async () => {
    serve((c) =>
      c.method === 'POST' && c.url === '/api/folders/f1/worktrees'
        ? Response.json(worktree({ path: MADE, branch: 'fix/x', main: false }), { status: 201 })
        : undefined,
    )
    render(panel())
    fireEvent.click(await screen.findByRole('button', { name: '워크트리 추가' }))
    const dlg = screen.getByRole('dialog', { name: '새 워크트리' })
    const name = within(dlg).getByLabelText('브랜치 이름')
    expect(document.activeElement).toBe(name)
    const base = within(dlg).getByLabelText('기준') as HTMLSelectElement
    await vi.waitFor(() => expect(base.options.length).toBe(2))
    const make = within(dlg).getByRole('button', { name: '만들기' }) as HTMLButtonElement
    expect(make.disabled).toBe(true)
    fireEvent.input(name, { target: { value: 'fix/notify' } })
    expect(within(dlg).getByText(/이미 워크트리가 있는 브랜치입니다/)).toBeTruthy()
    expect(make.disabled).toBe(true)
    fireEvent.input(name, { target: { value: 'fix/x' } })
    expect(dlg.textContent).toContain('~/dev/Mori.wt/fix-x에 만듭니다')
    fireEvent.click(make)
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([{ branch: 'fix/x', create: true, base: 'main' }])
    expect(toastTexts()).toEqual([['워크트리를 만들었습니다', 'info']])
    // Shown before the folder list has it.
    await vi.waitFor(() => expect(statusCalls().at(-1)).toBe(MADE))
    expect(within(region('워크트리 3')).getByRole('button', { name: /^fix\/x ~/ }).getAttribute('aria-current')).toBe('true')
  })

  it('says why a worktree could not be made, and keeps the sheet', async () => {
    serve((c) => (c.method === 'POST' ? fail(422, 'git_failed', "fatal: a branch named 'fix/x' already exists") : undefined))
    render(panel())
    fireEvent.click(await screen.findByRole('button', { name: '워크트리 추가' }))
    const dlg = screen.getByRole('dialog', { name: '새 워크트리' })
    await vi.waitFor(() => expect((within(dlg).getByLabelText('기준') as HTMLSelectElement).options.length).toBe(2))
    fireEvent.input(within(dlg).getByLabelText('브랜치 이름'), { target: { value: 'fix/x' } })
    fireEvent.submit(within(dlg).getByLabelText('브랜치 이름').closest('form')!)
    expect((await within(dlg).findByRole('alert')).textContent).toBe("워크트리를 만들지 못했습니다. fatal: a branch named 'fix/x' already exists")
    expect(screen.getByRole('dialog', { name: '새 워크트리' })).toBe(dlg)
  })
})

describe('GitScreen', () => {
  it('opens one change at a time on a phone', async () => {
    serve()
    render(<GitScreen variant="phone" folder="f1" back="#/folders" />)
    const row = await screen.findByRole('button', { name: /^이름 바꿈 new\.md/ })
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(diffCalls()).toEqual([])
    fireEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('true')
    const box = document.getElementById(row.getAttribute('aria-controls')!)!
    await within(box).findByText('-staged')
    expect(diffCalls()).toEqual([{ path: MAIN, file: 'docs/new.md', orig: 'docs/old.md', staged: '1' }])
    expect(row.textContent).toContain('+1')
    expect(row.textContent).toContain('−1')

    const other = screen.getByRole('button', { name: '충돌 a.txt 양쪽에서 수정' })
    fireEvent.click(other)
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(other.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(other)
    expect(other.getAttribute('aria-expanded')).toBe('false')

    expect(screen.getByRole('link', { name: '뒤로' }).getAttribute('href')).toBe('#/folders')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Git')
    expect(screen.getByText('Mori · ~/dev/Mori')).toBeTruthy()
    expect(screen.getByRole('link', { name: /커밋 그래프/ }).getAttribute('href')).toBe(href({ name: 'graph', folder: 'f1', path: MAIN, head: false }))
    expect(region('브랜치').textContent).toContain('보기만 합니다. 커밋과 푸시는 터미널에서 하세요.')
  })

  it('marks the worktree of the session it came from', async () => {
    serve()
    gitFrom.value = 't3'
    render(<GitScreen variant="phone" folder="f1" back="#/t/t3" />)
    const wts = await screen.findByRole('region', { name: '워크트리 2' })
    expect(within(wts).getByRole('button', { name: /^fix\/notify ~/ }).textContent).toContain('이 세션')
    expect(within(wts).getByRole('button', { name: /^main ~/ }).textContent).not.toContain('이 세션')
    expect(within(wts).getByRole('button', { name: '새 워크트리' })).toBeTruthy()
  })

  it('shows another worktree by its address', async () => {
    serve()
    history.replaceState(null, '', '/#/git/f1')
    route.value = { name: 'git', folder: 'f1' }
    const { rerender } = render(<GitScreen variant="pc" folder="f1" />)
    const wts = await screen.findByRole('region', { name: '워크트리 2' })
    expect(within(wts).getByRole('button', { name: /^main ~/ }).getAttribute('aria-current')).toBe('true')
    expect(within(wts).getByRole('button', { name: /^main ~/ }).textContent).not.toContain('이 세션')
    fireEvent.click(within(wts).getByRole('button', { name: /^fix\/notify ~/ }))
    expect(route.value).toEqual({ name: 'git', folder: 'f1', path: WT })
    expect(location.hash).toBe(href({ name: 'git', folder: 'f1', path: WT }))
    rerender(<GitScreen variant="pc" folder="f1" path={WT} />)
    await vi.waitFor(() => expect(statusCalls()).toEqual([MAIN, WT]))
    expect(screen.getByText('Mori · ~/dev/Mori.wt/fix-notify')).toBeTruthy()

    fireEvent.click(within(wts).getByRole('button', { name: 'fix/notify 워크트리 메뉴' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '이 워크트리에서 새 세션' }))
    expect(route.value).toEqual({ name: 'new', folder: 'f1', wt: WT })
  })

  it('falls back to the folder’s own worktree for one it does not know', async () => {
    serve()
    render(<GitScreen variant="pc" folder="f1" path="/Users/me/elsewhere" />)
    await vi.waitFor(() => expect(statusCalls()).toEqual([MAIN]))
  })

  it('says when the folder is gone or not a repository', async () => {
    serve()
    render(<GitScreen variant="pc" folder="f9" />)
    expect(screen.getByText('폴더를 찾을 수 없습니다')).toBeTruthy()
    cleanup()
    folders.value = [folder({ repo: false, worktrees: [] })]
    render(<GitScreen variant="pc" folder="f1" />)
    expect(screen.getByText('이 폴더는 git 저장소가 아닙니다')).toBeTruthy()
    cleanup()
    ready.value = false
    render(<GitScreen variant="phone" folder="f1" back="#/folders" />)
    expect(screen.getByText('불러오는 중')).toBeTruthy()
    expect(statusCalls()).toEqual([])
  })
})
