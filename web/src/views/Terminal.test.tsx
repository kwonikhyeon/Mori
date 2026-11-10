import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeScreen } from '../../test/fakeScreen'
import { FakeWebSocket } from '../../test/fakeWs'
import { folder, status, term } from '../../test/fixtures'
import { inHost, withHost } from '../../test/scopes'
import { now } from '../lib/clock'
import { route } from '../lib/router'
import { core, folders, ready, resetStore, terminals } from '../lib/store'
import { toasts } from '../lib/toast'
import type { TerminalView } from '../lib/types'
import { openScreen } from '../lib/xterm'
import { Terminal, type TerminalProps } from './Terminal'

// jsdom cannot lay out xterm's cells: the view draws on a FakeScreen.
vi.mock('../lib/xterm', async () => {
  const { FakeScreen } = await import('../../test/fakeScreen')
  return { openScreen: vi.fn(async () => new FakeScreen()) }
})

interface Call {
  method: string
  url: string
  body: unknown
}

let calls: Call[] = []
let reply: (c: Call) => Response | undefined = () => undefined

const HOUR = 3_600_000

function load(ts: TerminalView[]) {
  terminals.value = new Map(ts.map((t) => [t.address, t]))
  ready.value = true
}

async function mount(t: TerminalView | null = term({ status: status('idle') }), p: Partial<TerminalProps> = {}) {
  if (t) load([t])
  const r = render(<Terminal addr="t1" variant="pc" {...p} />)
  await vi.waitFor(() => expect(FakeWebSocket.all.length).toBeGreaterThan(0))
  return { ...r, ws: FakeWebSocket.last() }
}

async function attach(ws: FakeWebSocket, cols = 80, rows = 24) {
  await act(() => {
    ws.open()
    ws.json({ type: 'attached', terminal: term(), cols, rows })
  })
}

/** The names of a menu's items, plain and checkable. */
const items = (menu: HTMLElement) => [...menu.querySelectorAll('[role^="menuitem"]')].map((i) => i.textContent)

const sent = (path: string, method = 'POST') => calls.filter((c) => c.url === path && c.method === method)

beforeEach(() => {
  FakeWebSocket.reset()
  FakeScreen.reset()
  vi.stubGlobal('WebSocket', FakeWebSocket)
  calls = []
  reply = () => undefined
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const raw = init.body
      const body = raw instanceof FormData ? raw : typeof raw === 'string' ? JSON.parse(raw) : undefined
      const c = { method: init.method ?? 'GET', url: String(url), body }
      calls.push(c)
      return reply(c) ?? (c.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({}))
    }),
  )
  now.value = 10 * HOUR
  folders.value = [folder()]
  core.value = { connected: true }
  history.replaceState(null, '', '/#/t/t1')
  route.value = { name: 'terminal', addr: 't1', git: false }
})

afterEach(() => {
  cleanup()
  resetStore()
  toasts.value = []
  route.value = { name: 'queue' }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Terminal on a PC', () => {
  it('names the session and offers the tools of B-PC', async () => {
    const { ws } = await mount()
    expect(screen.getByRole('heading', { level: 1, name: 'Claude Code' })).toBeTruthy()
    expect(screen.getByText('입력 대기')).toBeTruthy()
    expect(screen.getByText('claude · Mori / main')).toBeTruthy()
    for (const name of ['파일 올리기', '보기 전용', 'Git', '중단', '종료']) expect(screen.getByRole('button', { name })).toBeTruthy()
    expect(screen.getByRole('button', { name: '보기 전용' }).getAttribute('aria-pressed')).toBe('false')
    expect(ws.query().get('t')).toBe('t1')
    // The view draws on the screen it opened, and the screen takes the keys.
    await attach(ws)
    FakeScreen.last().type('ls\r')
    expect(ws.input()).toEqual(['ls\r'])
  })

  it('says it is connecting only when that lasts, and when the terminal is gone', async () => {
    const { ws } = await mount()
    const note = screen.getByText('연결 중').closest('.term-note')!
    expect(note.classList.contains('is-late')).toBe(true)
    await act(() => ws.drop(4404, 'no such terminal'))
    expect(screen.getByText('터미널을 찾을 수 없습니다')).toBeTruthy()
    expect(screen.getByRole('link', { name: '목록으로' }).getAttribute('href')).toBe('#/')
    // Nothing is left to do with it.
    expect(screen.queryByRole('button', { name: '종료' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: '터미널에 여러 줄 보내기' })).toBeNull()
  })

  it('sends several lines with ⌘ or Ctrl + Enter and clears the box', async () => {
    await mount()
    const box = screen.getByRole('textbox', { name: '터미널에 여러 줄 보내기' }) as HTMLTextAreaElement
    const send = screen.getByRole('button', { name: '보내기' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    fireEvent.input(box, { target: { value: 'fix the test\nthen run it' } })
    expect(send.disabled).toBe(false)
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(calls).toEqual([])
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true })
    await vi.waitFor(() => expect(box.value).toBe(''))
    expect(sent('/api/terminals/t1/send').map((c) => c.body)).toEqual([{ text: 'fix the test\nthen run it' }])
  })

  it("shows the screen's end once several lines are sent or the program is interrupted", async () => {
    await mount()
    const box = screen.getByRole('textbox', { name: '터미널에 여러 줄 보내기' }) as HTMLTextAreaElement
    fireEvent.input(box, { target: { value: 'go on' } })
    fireEvent.click(screen.getByRole('button', { name: '보내기' }))
    await vi.waitFor(() => expect(box.value).toBe(''))
    expect(FakeScreen.last().bottoms).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: '중단' }))
    await vi.waitFor(() => expect(FakeScreen.last().bottoms).toBe(2))
  })

  it('keeps the text when the program waits for an answer', async () => {
    reply = (c) =>
      c.url.endsWith('/send') ? Response.json({ error: { kind: 'blocked', message: '승인을 기다립니다' } }, { status: 409 }) : undefined
    await mount()
    const box = screen.getByRole('textbox', { name: '터미널에 여러 줄 보내기' }) as HTMLTextAreaElement
    fireEvent.input(box, { target: { value: 'go on' } })
    fireEvent.click(screen.getByRole('button', { name: '보내기' }))
    expect((await screen.findByRole('alert')).textContent).toBe('승인 대기 중 — 키로 응답')
    expect(box.value).toBe('go on')
    expect(toasts.value).toEqual([])
    // nothing went: the screen stays where it is
    expect(FakeScreen.last().bottoms).toBe(0)
    fireEvent.input(box, { target: { value: 'go on!' } })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('answers a blocked program down the stream, or with POST keys before it is attached', async () => {
    const { ws } = await mount(term({ status: status('blocked', { kind: 'permission', msg: 'Bash(npm test)를 실행할까요?' }) }))
    const ask = screen.getByRole('region', { name: '승인 대기 — 키로 응답' })
    expect(within(ask).getByText(/Bash\(npm test\)를 실행할까요\?/)).toBeTruthy()
    expect(within(ask).getAllByRole('button').map((b) => b.textContent)).toEqual(['1', '2', '3', 'Enter', 'Esc'])
    fireEvent.click(within(ask).getByRole('button', { name: '2' }))
    await vi.waitFor(() => expect(sent('/api/terminals/t1/keys').map((c) => c.body)).toEqual([{ keys: ['2'] }]))
    await attach(ws)
    fireEvent.click(within(ask).getByRole('button', { name: '1' }))
    fireEvent.click(within(ask).getByRole('button', { name: 'Enter' }))
    expect(ws.input()).toEqual(['1', '\r'])
    expect(sent('/api/terminals/t1/keys')).toHaveLength(1)
  })

  it('asks before ending the session, then ends it', async () => {
    await mount()
    fireEvent.click(screen.getByRole('button', { name: '종료' }))
    const dialog = screen.getByRole('dialog', { name: '이 세션을 종료할까요?' })
    expect(document.activeElement?.textContent).toBe('취소')
    fireEvent.click(within(dialog).getByRole('button', { name: '종료' }))
    await vi.waitFor(() => expect(sent('/api/terminals/t1/kill')).toHaveLength(1))
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('interrupts with one press', async () => {
    await mount()
    fireEvent.click(screen.getByRole('button', { name: '중단' }))
    await vi.waitFor(() => expect(sent('/api/terminals/t1/interrupt')).toHaveLength(1))
  })

  it('opens and closes the Git aside from its toggle', async () => {
    const { rerender } = await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Git' }))
    expect(route.value).toEqual({ name: 'terminal', addr: 't1', git: true })
    expect(location.hash).toBe('#/t/t1/git')
    rerender(<Terminal addr="t1" variant="pc" git />)
    const git = screen.getByRole('button', { name: 'Git' })
    expect(git.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(git)
    expect(route.value).toEqual({ name: 'terminal', addr: 't1', git: false })
  })

  it('has no Git toggle for a terminal outside the folders or in a folder without Git', async () => {
    const { unmount } = await mount(term({ folder_id: '', worktree: '' }))
    expect(screen.queryByRole('button', { name: 'Git' })).toBeNull()
    unmount()
    folders.value = [folder({ repo: false, worktrees: [] })]
    await mount(term({ worktree: '' }))
    expect(screen.queryByRole('button', { name: 'Git' })).toBeNull()
  })

  it('renames in place: Enter keeps it, Escape does not', async () => {
    await mount()
    fireEvent.click(screen.getByRole('button', { name: '이름 바꾸기' }))
    let field = screen.getByRole('textbox', { name: '세션 이름' }) as HTMLInputElement
    expect(field.value).toBe('Claude Code')
    expect(document.activeElement).toBe(field)
    fireEvent.input(field, { target: { value: '리뷰' } })
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(screen.getByRole('heading', { level: 1, name: 'Claude Code' })).toBeTruthy()
    expect(calls.filter((c) => c.method === 'PATCH')).toEqual([])

    fireEvent.click(screen.getByRole('button', { name: '이름 바꾸기' }))
    field = screen.getByRole('textbox', { name: '세션 이름' }) as HTMLInputElement
    fireEvent.input(field, { target: { value: '  리뷰  ' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await vi.waitFor(() => expect(sent('/api/terminals/t1', 'PATCH').map((c) => c.body)).toEqual([{ title: '리뷰' }]))
  })

  it('types an uploaded file\'s path where the cursor is, and refuses one over 8 MB', async () => {
    reply = (c) => (c.url.endsWith('/files') ? Response.json({ path: '/Users/me/dev/Mori/.mori/up/a b.png', bytes: 3 }) : undefined)
    const { ws } = await mount()
    await attach(ws)
    const input = document.querySelector<HTMLInputElement>('input[type=file]')!
    const small = new File(['png'], 'a b.png', { type: 'image/png' })
    const big = new File(['x'], 'big.bin')
    Object.defineProperty(big, 'size', { value: 9 << 20 })
    fireEvent.change(input, { target: { files: [big, small] } })
    await vi.waitFor(() => expect(ws.input()).toEqual(['"/Users/me/dev/Mori/.mori/up/a b.png" ']))
    const up = sent('/api/terminals/t1/files')
    expect(up).toHaveLength(1)
    expect(((up[0].body as FormData).get('file') as File).name).toBe('a b.png')
    expect(toasts.value.map((t) => [t.text, t.kind])).toEqual([['big.bin: 8 MB를 넘는 파일은 올릴 수 없습니다', 'error']])
  })

  it('only watches: attaches again as an observer and stops typing', async () => {
    const { ws } = await mount()
    await attach(ws)
    fireEvent.click(screen.getByRole('button', { name: '보기 전용' }))
    const watch = FakeWebSocket.last()
    expect(watch).not.toBe(ws)
    expect(ws.closedWith).not.toBeNull()
    expect(watch.query().get('observe')).toBe('1')
    expect(watch.query().get('cols')).toBeNull()
    await attach(watch)
    expect(screen.getByRole('button', { name: '보기 전용' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('보기 전용 — 입력과 크기 변경을 보내지 않습니다')).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: '터미널에 여러 줄 보내기' })).toBeNull()
    expect(screen.queryByRole('button', { name: '파일 올리기' })).toBeNull()
    expect(FakeScreen.last().input).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '보기 전용 끄기' }))
    expect(FakeWebSocket.last().query().get('observe')).toBeNull()
  })

  it('offers to fit this screen once the sizes have differed for a while', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(840)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(425)
    const { ws } = await mount()
    // (840 − 14) / 8 and 425 / 17
    expect([ws.query().get('cols'), ws.query().get('rows')]).toEqual(['103', '25'])
    await attach(ws, 120, 40)
    expect(screen.queryByRole('button', { name: '이 화면에 맞추기' })).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: '이 화면에 맞추기' }, { timeout: 2000 }))
    expect(ws.messages().filter((m) => m.type === 'resize')).toEqual([{ type: 'resize', cols: 103, rows: 25 }])
    await act(() => ws.json({ type: 'size', cols: 103, rows: 25 }))
    expect(screen.queryByRole('button', { name: '이 화면에 맞추기' })).toBeNull()
  })

  it('attaches at the terminal\'s own size while it cannot measure the stage', async () => {
    const { ws } = await mount(term({ cols: 132, rows: 43 }))
    expect([ws.query().get('cols'), ws.query().get('rows')]).toEqual(['132', '43'])
  })

  it('lets go of the screen and the stream when it closes', async () => {
    const { ws, unmount } = await mount()
    await attach(ws)
    unmount()
    expect(FakeScreen.last().disposed).toBe(true)
    expect(ws.closedWith).not.toBeNull()
  })

  it('names the host of the session when there are others', () => {
    const s = withHost()
    s.terminals.value = new Map([['t1', term()]])
    s.folders.value = [folder()]
    s.ready.value = true
    render(inHost(s, <Terminal addr="t1" variant="pc" />))
    expect(document.querySelector('.term-sub')!.textContent).toMatch(/^desk · /)
    cleanup()
    render(inHost(s, <Terminal addr="t1" variant="phone" back="#/h/h_desk0001" />))
    expect(within(document.querySelector('.term-head') as HTMLElement).getByText('desk')).toBeTruthy()
  })

  it("keeps the host's name apart from the screen's box", async () => {
    const s = withHost()
    s.terminals.value = new Map([['t1', term()]])
    s.folders.value = [folder()]
    s.ready.value = true
    render(inHost(s, <Terminal addr="t1" variant="phone" back="#/h/h_desk0001" />))
    await vi.waitFor(() => expect(FakeScreen.all).toHaveLength(1))
    const box = vi.mocked(openScreen).mock.lastCall![0]
    const tag = within(document.querySelector('.term-head') as HTMLElement).getByText('desk')
    // A class the two share gives the screen's box the name's pill: it clips the screen.
    expect([...tag.classList].filter((c) => box.classList.contains(c))).toEqual([])
  })
})

describe('An ended program', () => {
  const ended = () =>
    term({ state: 'finished', status: null, pid: null, exit_code: 0, reason: 'exited', finished_ms: 8 * HOUR })

  it('paints its last text, says how it ended and can be cleared from the list', async () => {
    reply = (c) => (c.url.includes('/text') ? Response.json({ text: 'done\nbye', complete: true, how: 'screen' }) : undefined)
    const { ws } = await mount(ended())
    expect(screen.getByText('프로그램이 끝났습니다')).toBeTruthy()
    expect(screen.getByText(/코드 0 · 2시간 전/)).toBeTruthy()
    for (const name of ['종료', '중단', '보기 전용', '파일 올리기']) expect(screen.queryByRole('button', { name })).toBeNull()
    expect(screen.queryByRole('textbox', { name: '터미널에 여러 줄 보내기' })).toBeNull()
    expect(screen.getByRole('link', { name: '새 세션' }).getAttribute('href')).toBe('#/new?folder=f1&wt=%2FUsers%2Fme%2Fdev%2FMori')

    await act(() => {
      ws.open()
      ws.json({ type: 'closed', reason: 'exited', exit_code: 0, signal: null })
      ws.drop(1000)
    })
    await vi.waitFor(() => expect(FakeScreen.last().text).toBe('done\r\nbye\x1b[?25l'))
    expect(sent('/api/terminals/t1/text?lines=1000', 'GET')).toHaveLength(1)
    expect(FakeScreen.last().input).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: '목록에서 지우기' }))
    await vi.waitFor(() => expect(route.value).toEqual({ name: 'queue' }))
    expect(sent('/api/terminals/t1', 'DELETE')).toHaveLength(1)
  })

  it('says how it ended when the stream says it first', async () => {
    const { ws } = await mount()
    await attach(ws)
    await act(() => {
      ws.json({ type: 'closed', reason: 'killed', exit_code: null, signal: 9 })
      ws.drop(1000)
    })
    expect(screen.getByText(/신호 9/)).toBeTruthy()
    // It was attached: the stream painted the end, so no text is fetched.
    expect(calls.filter((c) => c.url.includes('/text'))).toEqual([])
  })

  it('attaches to the host it was opened on and reads its last text there', async () => {
    const s = withHost()
    s.terminals.value = new Map([['t1', ended()]])
    s.folders.value = [folder()]
    s.ready.value = true
    reply = (c) => (c.url.includes('/text') ? Response.json({ text: 'done\nbye', complete: true, how: 'screen' }) : undefined)
    render(inHost(s, <Terminal addr="t1" variant="pc" />))
    await vi.waitFor(() => expect(FakeWebSocket.all.length).toBeGreaterThan(0))
    const ws = FakeWebSocket.last()
    expect(new URL(ws.url).pathname).toBe('/h/h_desk0001/ws/attach')
    await act(() => {
      ws.open()
      ws.json({ type: 'closed', reason: 'exited', exit_code: 0, signal: null })
      ws.drop(1000)
    })
    await vi.waitFor(() => expect(FakeScreen.last().text).toBe('done\r\nbye\x1b[?25l'))
    expect(sent('/h/h_desk0001/api/terminals/t1/text?lines=1000', 'GET')).toHaveLength(1)
    expect(sent('/api/terminals/t1/text?lines=1000', 'GET')).toHaveLength(0)
  })
})

describe('Terminal on a phone', () => {
  const phone = (t?: TerminalView | null, back = '#/folders') => mount(t, { variant: 'phone', back })

  it('goes back to the list it came from and opens Git for the worktree', async () => {
    await phone()
    expect(screen.getByRole('link', { name: '뒤로' }).getAttribute('href')).toBe('#/folders')
    expect(screen.getByRole('link', { name: 'Git' }).getAttribute('href')).toBe('#/git/f1?path=%2FUsers%2Fme%2Fdev%2FMori')
    expect(screen.getByRole('heading', { level: 1, name: 'Claude Code' })).toBeTruthy()
  })

  it('types the quick keys once attached, as the program reads them', async () => {
    const { ws } = await phone()
    const keys = screen.getByRole('region', { name: '빠른 키' })
    const names = within(keys).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)
    expect(names).toEqual(['Esc', 'Tab', 'Shift+Tab', '위 화살표', '아래 화살표', '왼쪽 화살표', '오른쪽 화살표', 'Enter', 'Ctrl+C'])
    const esc = within(keys).getByRole('button', { name: 'Esc' }) as HTMLButtonElement
    expect(esc.disabled).toBe(true)
    await attach(ws)
    expect(esc.disabled).toBe(false)
    fireEvent.click(esc)
    fireEvent.click(within(keys).getByRole('button', { name: '위 화살표' }))
    FakeScreen.last().app = true
    fireEvent.click(within(keys).getByRole('button', { name: '위 화살표' }))
    fireEvent.click(within(keys).getByRole('button', { name: 'Ctrl+C' }))
    expect(ws.input()).toEqual(['\x1b', '\x1b[A', '\x1bOA', '\x03'])
  })

  it('answers a blocked program from four big keys', async () => {
    await phone(term({ status: status('blocked', { msg: '파일을 고칠까요?' }) }))
    const ask = screen.getByRole('region', { name: '승인 대기 — 키로 응답' })
    expect(within(ask).getByText('파일을 고칠까요?')).toBeTruthy()
    expect(within(ask).getAllByRole('button').map((b) => b.textContent)).toEqual(['1', '2', '3', 'Esc'])
  })

  it('keeps the other tools in its menu', async () => {
    const { ws } = await phone()
    await attach(ws)
    fireEvent.click(screen.getByRole('button', { name: '더 보기' }))
    const menu = screen.getByRole('menu')
    expect(items(menu)).toEqual(['파일 올리기', '보기 전용', '이름 바꾸기', '중단', '종료'])
    fireEvent.click(within(menu).getByRole('menuitemcheckbox', { name: '보기 전용' }))
    expect(FakeWebSocket.last().query().get('observe')).toBe('1')
    expect(screen.getByText('보기 전용 — 입력과 크기 변경을 보내지 않습니다')).toBeTruthy()
    expect(screen.queryByRole('region', { name: '빠른 키' })).toBeNull()
  })

  it('sends from a one-line box with an icon button', async () => {
    await phone()
    const box = screen.getByRole('textbox', { name: '터미널에 여러 줄 보내기' }) as HTMLTextAreaElement
    expect(box.rows).toBe(1)
    expect(box.placeholder).toBe('여러 줄로 보내기')
    fireEvent.input(box, { target: { value: 'y' } })
    fireEvent.click(screen.getByRole('button', { name: '보내기' }))
    await vi.waitFor(() => expect(sent('/api/terminals/t1/send').map((c) => c.body)).toEqual([{ text: 'y' }]))
  })

  it('clears an ended program and goes back to where it came from', async () => {
    await phone(term({ state: 'finished', pid: null, exit_code: 1, reason: 'exited', finished_ms: 9 * HOUR }))
    expect(screen.getByText(/코드 1/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '더 보기' }))
    expect(items(screen.getByRole('menu'))).toEqual(['이름 바꾸기', '목록에서 지우기'])
    fireEvent.click(screen.getAllByRole('button', { name: '목록에서 지우기' })[0])
    await vi.waitFor(() => expect(route.value).toEqual({ name: 'folders' }))
  })
})
