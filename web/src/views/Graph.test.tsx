import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { folder } from '../../test/fixtures'
import { inHost, withHost } from '../../test/scopes'
import { A, B, C, COMMITS, diffOf, LOG, linear, MAIN, NOW } from '../../test/history'
import { spoken } from '../../test/spoken'
import { closeContext, ContextMenuHost } from '../components/ContextMenu'
import { now } from '../lib/clock'
import { href, route, type Route } from '../lib/router'
import { folders, ready, resetStore } from '../lib/store'
import { toasts } from '../lib/toast'
import { GraphScreen } from './Graph'
import type { Variant } from './rows'
import { forgetCommits, graphFrom, shownLog } from './useLog'

interface Call {
  method: string
  url: string
}

type Reply = Response | Promise<Response> | undefined

let calls: Call[] = []
let reply: (c: Call) => Reply = () => undefined

const url = (c: Call) => new URL(c.url, 'http://mori.test')
const reads = (path: string) => calls.filter((c) => url(c).pathname === path).map((c) => Object.fromEntries(url(c).searchParams))
const fail = (status: number, kind: string, message: string) => Response.json({ error: { kind, message } }, { status })

function serve(over: (c: Call) => Reply = () => undefined) {
  reply = (c) => {
    const o = over(c)
    if (o) return o
    const u = url(c)
    if (u.pathname === '/api/git/log') return Response.json(LOG)
    if (u.pathname === '/api/git/commit') return Response.json(COMMITS[u.searchParams.get('rev')!])
    if (u.pathname === '/api/git/diff') return Response.json({ diff: diffOf(u.searchParams.get('file')!), truncated: false })
    return undefined
  }
}

/** A reply the test lets go of. */
function held() {
  let let_go!: () => void
  const wait = new Promise<void>((r) => (let_go = r))
  return { let_go, wait }
}

/** The screen as Shell draws it: its props follow the address. */
function Routed({ variant }: { variant: Variant }) {
  const r = route.value
  if (r.name !== 'graph') return null
  return <GraphScreen variant={variant} folder={r.folder} path={r.path} head={r.head} c={r.c} back="#/git/f1" />
}

function open(variant: Variant, r: Partial<Extract<Route, { name: 'graph' }>> = {}) {
  route.value = { name: 'graph', folder: 'f1', head: false, ...r }
  return render(<Routed variant={variant} />)
}

const list = () => screen.findByRole('list', { name: '커밋' })
const rows = () => within(screen.getByRole('list', { name: '커밋' })).getAllByRole('link')
const graph = (c?: string, head = false) => ({ name: 'graph', folder: 'f1', head, c })

beforeEach(() => {
  calls = []
  reply = () => undefined
  vi.stubGlobal(
    'fetch',
    vi.fn(async (u: string, init: RequestInit = {}) => {
      const c = { method: init.method ?? 'GET', url: String(u) }
      calls.push(c)
      return (await reply(c)) ?? Response.json({})
    }),
  )
  folders.value = [folder()]
  ready.value = true
  now.value = NOW
  toasts.value = []
})

afterEach(() => {
  cleanup()
  resetStore()
  forgetCommits()
  shownLog.value = null
  graphFrom.value = null
  toasts.value = []
  route.value = { name: 'queue' }
  history.replaceState(null, '', '/')
  vi.unstubAllGlobals()
})

describe('GraphScreen on a PC', () => {
  it('draws a row for each commit with its names and its lines', async () => {
    serve()
    open('pc')
    await list()
    expect(rows()).toHaveLength(3)
    expect(screen.getByRole('link', { name: '현재 브랜치 main 원격 origin/main 태그 v0.2.0 fix/notify 병합 ccccccc 김하늘 5분 전' })).toBe(rows()[0])
    expect(screen.getByRole('link', { name: 'fix/notify 알림이 두 번 뜨던 문제 고침 bbbbbbb Lee 1시간 전' })).toBe(rows()[1])
    expect(screen.getByRole('link', { name: '처음 aaaaaaa 김하늘 3일 전' })).toBe(rows()[2])
    expect(rows()[0].getAttribute('href')).toBe(href({ name: 'graph', folder: 'f1', head: false, c: C }))

    // HEAD's ring, a dot for each commit, and the lines by colour
    expect(rows().map((a) => a.querySelectorAll('.gr-ring').length)).toEqual([1, 0, 0])
    expect(rows().map((a) => a.querySelectorAll('.gr-dot').length)).toEqual([1, 1, 1])
    expect([...rows()[1].querySelectorAll('.gr-edge')].map((p) => p.getAttribute('class'))).toEqual(['gr-edge lane-0', 'gr-edge lane-1'])
    // Tab reaches the first row; the arrow keys the others.
    expect(rows().map((a) => a.tabIndex)).toEqual([0, -1, -1])

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Git 그래프')
    expect(screen.getByText('Mori · ~/dev/Mori · 보기만 합니다')).toBeTruthy()
    expect(screen.getByText('커밋 3개 · 처음 커밋까지 모두 보입니다')).toBeTruthy()
    expect(reads('/api/git/log')).toEqual([{ path: MAIN, limit: '200' }])
    expect(shownLog.value?.path).toBe(MAIN)
    expect(shownLog.value?.byHash.get(B)?.subject).toBe('알림이 두 번 뜨던 문제 고침')
  })

  it('picks a commit with a click and walks the rows with the arrow keys', async () => {
    serve()
    history.replaceState(null, '', '/#/graph/f1')
    open('pc')
    await list()
    const before = history.length
    fireEvent.click(rows()[1])
    expect(route.value).toEqual(graph(B))
    expect(location.hash).toBe(href(graph(B) as Route))
    expect(history.length).toBe(before)
    expect(rows().map((a) => a.getAttribute('aria-current'))).toEqual([null, 'true', null])
    expect(rows().map((a) => a.tabIndex)).toEqual([-1, 0, -1])

    rows()[1].focus()
    fireEvent.keyDown(rows()[1], { key: 'ArrowDown' })
    expect(route.value).toEqual(graph(A))
    expect(document.activeElement).toBe(rows()[2])
    fireEvent.keyDown(rows()[2], { key: 'ArrowDown' })
    expect(route.value).toEqual(graph(A))
    fireEvent.keyDown(rows()[2], { key: 'Home' })
    expect(route.value).toEqual(graph(C))
    expect(document.activeElement).toBe(rows()[0])
    fireEvent.keyDown(rows()[0], { key: 'End' })
    expect(route.value).toEqual(graph(A))
    fireEvent.keyDown(rows()[2], { key: 'ArrowUp' })
    expect(route.value).toEqual(graph(B))
    expect(document.activeElement).toBe(rows()[1])
    expect(history.length).toBe(before)

    // Picking the one picked keeps it.
    fireEvent.click(rows()[1])
    expect(route.value).toEqual(graph(B))
    // Only a plain click is the screen's; the others open the row's address.
    fireEvent.click(rows()[0], { metaKey: true })
    expect(route.value).toEqual(graph(B))
  })

  it('brings the commit in the address into view', async () => {
    serve()
    const into = vi.fn()
    Element.prototype.scrollIntoView = into
    try {
      open('pc', { c: A })
      await list()
      await vi.waitFor(() => expect(into).toHaveBeenCalledOnce())
      expect(into.mock.contexts[0]).toBe(rows()[2])
      expect(into).toHaveBeenCalledWith({ block: 'nearest' })
      expect(rows()[2].getAttribute('aria-current')).toBe('true')
      expect(rows()[2].tabIndex).toBe(0)
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView
    }
  })

  it('reads 200 more at a time, and keeps the length for HEAD만', async () => {
    const wait = held()
    serve((c) => {
      const q = url(c).searchParams
      if (url(c).pathname !== '/api/git/log') return undefined
      const n = Number(q.get('limit'))
      const g = linear(n, true)
      return n > 200 ? wait.wait.then(() => Response.json(g)) : Response.json(g)
    })
    open('pc')
    await list()
    expect(rows()).toHaveLength(200)
    expect(screen.getByText('커밋 200개')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '더 불러오기' }))
    const pending = await screen.findByRole('button', { name: '불러오는 중' })
    expect((pending as HTMLButtonElement).disabled).toBe(true)
    // What was there stays while the longer log comes.
    expect(rows()).toHaveLength(200)
    wait.let_go()
    await screen.findByText('커밋 400개')
    expect(rows()).toHaveLength(400)

    fireEvent.click(screen.getByRole('button', { name: 'HEAD만' }))
    expect(route.value).toEqual(graph(undefined, true))
    await vi.waitFor(() => expect(reads('/api/git/log').at(-1)).toEqual({ path: MAIN, limit: '400', head: '1' }))
    expect(screen.getByRole('button', { name: 'HEAD만' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('sends a longer history to the terminal', async () => {
    serve((c) => (url(c).pathname === '/api/git/log' ? Response.json(linear(2000, true)) : undefined))
    open('pc')
    await screen.findByText('커밋 2,000개 · 더 오래된 커밋은 터미널에서 보세요', {}, { timeout: 5000 })
    expect(screen.queryByRole('button', { name: '더 불러오기' })).toBeNull()
  })

  it('keeps the list when a read fails, and says why', async () => {
    let failing = false
    serve((c) => (failing && url(c).pathname === '/api/git/log' ? fail(422, 'git_failed', 'git log가 실패했습니다') : undefined))
    open('pc')
    await list()
    failing = true
    fireEvent.click(screen.getByRole('button', { name: '새로 고침' }))
    expect((await screen.findByRole('alert')).textContent).toBe('git log가 실패했습니다')
    expect(rows()).toHaveLength(3)
    failing = false
    fireEvent.click(screen.getByRole('button', { name: '새로 고침' }))
    await vi.waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(reads('/api/git/log')).toHaveLength(3)
  })

  it('says why there is no graph', async () => {
    serve((c) => (url(c).pathname === '/api/git/log' ? fail(422, 'git_failed', 'git log가 실패했습니다') : undefined))
    open('pc')
    expect((await screen.findByRole('alert')).textContent).toBe('git log가 실패했습니다')
    cleanup()

    serve((c) => (url(c).pathname === '/api/git/log' ? Response.json({ commits: [], width: 0, more: false }) : undefined))
    open('pc')
    expect(await screen.findByText('아직 커밋이 없습니다')).toBeTruthy()
    expect(screen.getByText('첫 커밋을 만들면 여기에 보입니다.')).toBeTruthy()
    cleanup()

    open('pc', { folder: 'f9' })
    expect(screen.getByText('폴더를 찾을 수 없습니다')).toBeTruthy()
    cleanup()
    folders.value = [folder({ repo: false, worktrees: [] })]
    open('pc')
    expect(screen.getByText('이 폴더는 git 저장소가 아닙니다')).toBeTruthy()
    expect((screen.getByRole('button', { name: '새로 고침' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('goes back to the screen it was opened from', async () => {
    serve()
    graphFrom.value = { host: '', folder: 'f1', href: href({ name: 'terminal', addr: 't1', git: true }) }
    open('pc')
    expect(screen.getByRole('link', { name: '작업 화면으로' }).getAttribute('href')).toBe('#/t/t1/git')
    cleanup()
    graphFrom.value = { host: '', folder: 'f1', href: href({ name: 'git', folder: 'f1', path: MAIN }) }
    open('pc')
    expect(screen.getByRole('link', { name: 'Git 화면으로' }).getAttribute('href')).toBe(href({ name: 'git', folder: 'f1', path: MAIN }))
    cleanup()
    graphFrom.value = { host: '', folder: 'f2', href: '#/t/t9/git' }
    open('pc', { path: MAIN })
    expect(screen.getByRole('link', { name: 'Git 화면으로' }).getAttribute('href')).toBe(href({ name: 'git', folder: 'f1', path: MAIN }))
  })

  it('keeps where it was opened apart for each host', async () => {
    const s = withHost()
    s.folders.value = [folder()]
    s.ready.value = true
    serve((c) => (url(c).pathname === '/h/h_desk0001/api/git/log' ? Response.json(LOG) : undefined))
    graphFrom.value = { host: 'h_desk0001', folder: 'f1', href: s.href({ name: 'terminal', addr: 't1', git: true }) }
    route.value = { name: 'graph', folder: 'f1', head: false, host: 'h_desk0001' }
    render(inHost(s, <Routed variant="pc" />))
    expect(screen.getByRole('link', { name: '작업 화면으로' }).getAttribute('href')).toBe('#/h/h_desk0001/t/t1/git')
    cleanup()
    graphFrom.value = { host: '', folder: 'f1', href: '#/t/t1/git' }
    render(inHost(s, <Routed variant="pc" />))
    expect(screen.getByRole('link', { name: 'Git 화면으로' }).getAttribute('href')).toBe('#/h/h_desk0001/git/f1')
  })
})

describe('a commit row\'s context menu (spec §3 #242)', () => {
  afterEach(() => act(() => closeContext()))

  it('opens the commit and copies its hash and subject', async () => {
    serve()
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    open('pc')
    render(<ContextMenuHost />)
    await list()
    const row = rows()[1]
    fireEvent.contextMenu(row.querySelector('.gr-text')!, { button: 2, clientX: 5, clientY: 5 })
    const m = screen.getByRole('menu', { name: '커밋' })
    expect([...m.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent)).toEqual(['커밋 보기', '해시 복사', '짧은 해시 복사', '제목 복사'])
    fireEvent.click(screen.getByRole('menuitem', { name: '해시 복사' }))
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(B))
    await vi.waitFor(() => expect(toasts.value.at(-1)?.text).toBe('해시를 복사했습니다'))
    fireEvent.contextMenu(row, { button: 2 })
    fireEvent.click(screen.getByRole('menuitem', { name: '커밋 보기' }))
    expect(route.value).toEqual(graph(B))
  })
})

describe('GraphScreen on a phone', () => {
  it('opens a commit in a sheet, then one file at a time', async () => {
    serve()
    open('phone')
    await list()
    expect(screen.getByText('Mori · 커밋 3개 · 보기만 합니다')).toBeTruthy()
    expect(screen.getByRole('link', { name: '뒤로' }).getAttribute('href')).toBe('#/git/f1')
    // A row has room for one name; the rest are counted.
    expect(screen.getByRole('link', { name: 'fix/notify 병합 현재 브랜치 main 이름표 2개 더 ccccccc 5분 전' })).toBe(rows()[0])
    expect(within(rows()[0]).getByTitle('원격 origin/main, 태그 v0.2.0').textContent).toBe('+2이름표 2개 더')
    // HEAD's branch goes by its name alone there, and in full in the sheet.
    expect(within(rows()[0]).getByTitle('현재 브랜치 main').textContent).toBe('main현재 브랜치 main')

    fireEvent.click(rows()[1])
    const sheet = screen.getByRole('region', { name: '커밋' })
    expect(document.activeElement).toBe(within(sheet).getByRole('heading', { level: 2 }))
    expect(within(sheet).getByText('bbbbbbb')).toBeTruthy()
    expect(await within(sheet).findByRole('heading', { name: '알림이 두 번 뜨던 문제 고침' })).toBeTruthy()
    expect(within(sheet).getByText('푸시가 두 번 보내지던 것을 막습니다.')).toBeTruthy()
    expect([...within(sheet).getByRole('region', { name: '커밋 내용' }).children].map(spoken)).toEqual([
      '알림이 두 번 뜨던 문제 고침',
      '푸시가 두 번 보내지던 것을 막습니다.',
      'fix/notify',
      'Lee · 1시간 전 · 부모 aaaaaaa',
    ])
    expect(reads('/api/git/commit')).toEqual([{ path: MAIN, rev: B }])

    const files = within(sheet).getByRole('region', { name: '파일 2' })
    const test = within(files).getByRole('button', { name: /^추가 notify_test\.go/ })
    expect(test.textContent).toContain('+12')
    fireEvent.click(test)
    const diff = await within(sheet).findByRole('region', { name: 'notify_test.go 변경 내용' })
    await within(diff).findByText('+new internal/push/notify_test.go')
    expect(reads('/api/git/diff')).toEqual([{ path: MAIN, file: 'internal/push/notify_test.go', rev: B }])
    expect(document.activeElement).toBe(within(sheet).getByRole('button', { name: '파일 목록으로' }))
    expect(within(sheet).queryByRole('region', { name: '커밋 내용' })).toBeNull()

    // Escape goes back a step at a time.
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(within(sheet).queryByRole('region', { name: 'notify_test.go 변경 내용' })).toBeNull()
    expect(document.activeElement).toBe(within(sheet).getByRole('button', { name: /^추가 notify_test\.go/ }))
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('region', { name: '커밋' })).toBeNull()
    expect(route.value).toEqual(graph(undefined))
    await vi.waitFor(() => expect(document.activeElement).toBe(rows()[1]))
  })

  it('follows a parent and closes', async () => {
    serve()
    open('phone', { c: B })
    const sheet = await screen.findByRole('region', { name: '커밋' })
    fireEvent.click(await within(sheet).findByRole('link', { name: 'aaaaaaa' }))
    expect(route.value).toEqual(graph(A))
    expect(await within(sheet).findByRole('heading', { name: '처음' })).toBeTruthy()
    expect([...within(sheet).getByRole('region', { name: '커밋 내용' }).children].map(spoken)).toEqual(['처음', '김하늘 · 3일 전 · 처음 커밋'])
    fireEvent.click(within(sheet).getByRole('button', { name: '커밋 닫기' }))
    expect(route.value).toEqual(graph(undefined))
    expect(screen.queryByRole('region', { name: '커밋' })).toBeNull()
  })

  it('names in the sheet all the names its row has no room for', async () => {
    serve()
    open('phone', { c: C })
    const sheet = await screen.findByRole('region', { name: '커밋' })
    const sum = await within(sheet).findByRole('region', { name: '커밋 내용' })
    expect([...sum.children].map(spoken)).toEqual([
      'fix/notify 병합',
      '알림 고침을 가져옵니다.',
      '현재 브랜치 main 원격 origin/main 태그 v0.2.0',
      '김하늘 · 5분 전 · 부모 aaaaaaa, bbbbbbb',
    ])
    expect(within(sum).getByTitle('현재 브랜치 main').textContent).toBe('HEAD → main현재 브랜치 main')
  })

  it('leaves the focus on the rows the arrow keys walk under it', async () => {
    serve()
    open('phone')
    await list()
    rows()[0].focus()
    fireEvent.keyDown(rows()[0], { key: 'ArrowDown' })
    expect(route.value).toEqual(graph(B))
    const sheet = screen.getByRole('region', { name: '커밋' })
    expect(document.activeElement).toBe(rows()[1])
    // A diff left open goes with its commit.
    fireEvent.click(await within(sheet).findByRole('button', { name: /^수정 notify\.go/ }))
    expect(await within(sheet).findByRole('region', { name: 'notify.go 변경 내용' })).toBeTruthy()
    rows()[1].focus()
    fireEvent.keyDown(rows()[1], { key: 'ArrowDown' })
    expect(route.value).toEqual(graph(A))
    expect(document.activeElement).toBe(rows()[2])
    expect(await within(sheet).findByRole('heading', { name: '처음' })).toBeTruthy()
    expect(document.activeElement).toBe(rows()[2])
    fireEvent.keyDown(rows()[2], { key: 'ArrowUp' })
    expect(await within(sheet).findByRole('heading', { name: '알림이 두 번 뜨던 문제 고침' })).toBeTruthy()
    expect(within(sheet).queryByRole('region', { name: 'notify.go 변경 내용' })).toBeNull()
    expect(document.activeElement).toBe(rows()[1])
  })
})
