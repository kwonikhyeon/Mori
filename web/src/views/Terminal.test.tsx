import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeScreen } from '../../test/fakeScreen'
import { FakeWebSocket } from '../../test/fakeWs'
import { folder, status, term } from '../../test/fixtures'
import { inHost, withHost } from '../../test/scopes'
import { now } from '../lib/clock'
import { resetPickPref, setPickOn } from '../lib/pickpref'
import { route } from '../lib/router'
import { resetSeen, seenMarks } from '../lib/seen'
import { forgetCommands } from '../lib/slash'
import { core, folders, ready, resetStore, terminals } from '../lib/store'
import { resetTermFont } from '../lib/termfont'
import { toasts } from '../lib/toast'
import type { TerminalView } from '../lib/types'
import { openScreen } from '../lib/xterm'
import { Terminal, type TerminalProps } from './Terminal'

// jsdom cannot lay out xterm's cells: the view draws on a FakeScreen.
vi.mock('../lib/xterm', async () => {
  const { FakeScreen } = await import('../../test/fakeScreen')
  return {
    openScreen: vi.fn(async (_el: HTMLElement, o: { fontSize: number }) => {
      const s = new FakeScreen()
      s.fontSize = o.fontSize
      return s
    }),
  }
})

interface Call {
  method: string
  url: string
  body: unknown
}

let calls: Call[] = []
let reply: (c: Call) => Response | Promise<Response> | undefined = () => undefined

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
  localStorage.clear()
  forgetCommands()
  resetTermFont()
  resetPickPref()
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
      return (await reply(c)) ?? (c.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({}))
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

  it('sends the syllable still being composed once the IME has put it in', async () => {
    await mount()
    const box = screen.getByRole('textbox', { name: '터미널에 여러 줄 보내기' }) as HTMLTextAreaElement
    fireEvent.input(box, { target: { value: '테스트 돌려' } })
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true, isComposing: true })
    fireEvent.input(box, { target: { value: '테스트 돌려줘' } })
    expect(calls).toEqual([])
    fireEvent.compositionEnd(box)
    await vi.waitFor(() => expect(box.value).toBe(''))
    expect(sent('/api/terminals/t1/send').map((c) => c.body)).toEqual([{ text: '테스트 돌려줘' }])
  })

  it('keeps what was typed until it is sent, on this device', async () => {
    const first = await mount()
    fireEvent.input(screen.getByRole('textbox', { name: '터미널에 여러 줄 보내기' }), { target: { value: '반쯤 쓴 글' } })
    first.unmount()
    await mount()
    const box = screen.getByRole('textbox', { name: '터미널에 여러 줄 보내기' }) as HTMLTextAreaElement
    expect(box.value).toBe('반쯤 쓴 글')
    fireEvent.click(screen.getByRole('button', { name: '보내기' }))
    await vi.waitFor(() => expect(box.value).toBe(''))
    cleanup()
    await mount()
    expect((screen.getByRole('textbox', { name: '터미널에 여러 줄 보내기' }) as HTMLTextAreaElement).value).toBe('')
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

  describe('a question the server names', () => {
    const ASK = '3.0badc0de'
    const asking = (ask = ASK) => term({ status: status('blocked', { kind: 'permission', msg: 'Bash(npm test)를 실행할까요?' }), ask })
    const region = () => screen.getByRole('region', { name: '승인 대기 — 키로 응답' })
    const conflict = (kind: string, message: string) => Response.json({ error: { kind, message } }, { status: 409 })
    const note = () => screen.queryByRole('status', { name: '거절하고 지시 — Esc를 누른 뒤 이 글을 보냅니다' })

    it('answers only that question, one answer at a time', async () => {
      let let_go = () => {}
      reply = (c) => (c.url.endsWith('/keys') ? new Promise((ok) => (let_go = () => ok(Response.json({})))) : undefined)
      const { ws } = await mount(asking())
      await attach(ws)
      const ask = region()
      fireEvent.click(within(ask).getByRole('button', { name: '2' }))
      await vi.waitFor(() => expect(sent('/api/terminals/t1/keys').map((c) => c.body)).toEqual([{ keys: ['2'], expect: ASK }]))
      // not down the stream, where it could land on the next question
      expect(ws.input()).toEqual([])
      const keys = within(ask).getAllByRole('button')
      expect(keys.every((b) => (b as HTMLButtonElement).disabled)).toBe(true)
      fireEvent.click(within(ask).getByRole('button', { name: '1' }))
      expect(sent('/api/terminals/t1/keys')).toHaveLength(1)
      const bottoms = FakeScreen.last().bottoms
      await act(() => let_go())
      await vi.waitFor(() => expect((within(ask).getByRole('button', { name: '1' }) as HTMLButtonElement).disabled).toBe(false))
      expect(FakeScreen.last().bottoms).toBe(bottoms + 1)
    })

    it('says when the question changed before the answer came', async () => {
      reply = (c) => (c.url.endsWith('/keys') ? conflict('changed', '질문이 바뀌었습니다. 화면을 보고 다시 고르세요') : undefined)
      await mount(asking())
      fireEvent.click(within(region()).getByRole('button', { name: 'Esc' }))
      await vi.waitFor(() => expect(toasts.value.map((t) => t.text)).toEqual(['질문이 바뀌었습니다. 화면을 보고 다시 고르세요']))
    })

    it('turns it down and sends what to do instead', async () => {
      await mount(asking())
      const turn = within(region()).getByRole('button', { name: '거절하고 지시' })
      expect(turn.getAttribute('aria-pressed')).toBe('false')
      fireEvent.click(turn)
      expect(turn.getAttribute('aria-pressed')).toBe('true')
      expect(note()).toBeTruthy()
      const box = screen.getByRole('textbox', { name: '거절하고 대신 보낼 글' }) as HTMLTextAreaElement
      // focused in the press itself, so that a phone opens its keyboard
      expect(document.activeElement).toBe(box)
      expect(box.placeholder).toBe('대신 할 일을 적으세요')
      fireEvent.input(box, { target: { value: '테스트부터 고쳐 줘' } })
      fireEvent.click(screen.getByRole('button', { name: '거절하고 보내기' }))
      await vi.waitFor(() =>
        expect(sent('/api/terminals/t1/reject').map((c) => c.body)).toEqual([{ text: '테스트부터 고쳐 줘', expect: ASK }]),
      )
      await vi.waitFor(() => expect(box.value).toBe(''))
      expect(note()).toBeNull()
      expect(turn.getAttribute('aria-pressed')).toBe('false')
      expect(sent('/api/terminals/t1/send')).toEqual([])
    })

    it('keeps the instruction when the question stays', async () => {
      reply = (c) => (c.url.endsWith('/reject') ? conflict('blocked', 'Esc를 보냈지만 아직 승인 대기입니다') : undefined)
      const { container } = await mount(asking())
      fireEvent.click(within(region()).getByRole('button', { name: '거절하고 지시' }))
      const box = screen.getByRole('textbox', { name: '거절하고 대신 보낼 글' }) as HTMLTextAreaElement
      fireEvent.input(box, { target: { value: 'stop' } })
      fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true, metaKey: true })
      await vi.waitFor(() => expect(toasts.value.map((t) => t.text)).toEqual(['Esc를 보냈지만 아직 승인 대기입니다']))
      expect(box.value).toBe('stop')
      expect(note()).toBeTruthy()
      // The toast is spoken as an alert (lib/announce.ts); the view itself holds none.
      expect(within(container as HTMLElement).queryByRole('alert')).toBeNull()
    })

    it('stops turning it down from 취소, Escape, a second press, or when the question changes', async () => {
      await mount(asking())
      const turn = () => within(region()).getByRole('button', { name: '거절하고 지시' })
      fireEvent.click(turn())
      fireEvent.click(within(note()!).getByRole('button', { name: '취소' }))
      expect(note()).toBeNull()
      expect(screen.getByRole('textbox', { name: '터미널에 여러 줄 보내기' })).toBeTruthy()

      fireEvent.click(turn())
      fireEvent.keyDown(screen.getByRole('textbox', { name: '거절하고 대신 보낼 글' }), { key: 'Escape' })
      expect(note()).toBeNull()

      fireEvent.click(turn())
      fireEvent.click(turn())
      expect(note()).toBeNull()

      fireEvent.click(turn())
      await act(() => load([asking('4.0badc0de')]))
      expect(note()).toBeNull()
      expect(turn().getAttribute('aria-pressed')).toBe('false')
    })

    it('offers to turn it down with the text a send could not deliver', async () => {
      reply = (c) => (c.url.endsWith('/send') ? conflict('blocked', '승인을 기다립니다') : undefined)
      await mount(asking())
      const box = screen.getByRole('textbox', { name: '터미널에 여러 줄 보내기' }) as HTMLTextAreaElement
      fireEvent.input(box, { target: { value: 'go on' } })
      fireEvent.click(screen.getByRole('button', { name: '보내기' }))
      const held = await screen.findByRole('alert')
      expect(held.textContent).toContain('승인 대기 중 — 키로 응답')
      fireEvent.click(within(held).getByRole('button', { name: '거절하고 이 글 보내기' }))
      await vi.waitFor(() => expect(sent('/api/terminals/t1/reject').map((c) => c.body)).toEqual([{ text: 'go on', expect: ASK }]))
      await vi.waitFor(() => expect(box.value).toBe(''))
      expect(screen.queryByRole('alert')).toBeNull()
    })
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

  it("offers the output's end while the screen is scrolled back, and says when output came", async () => {
    const { ws } = await mount()
    await attach(ws)
    const s = FakeScreen.last()
    expect(screen.queryByRole('button', { name: '맨 아래로' })).toBeNull()
    act(() => s.scrollTo(false))
    const jump = screen.getByRole('button', { name: '맨 아래로' })
    expect(jump.classList.contains('btn-primary')).toBe(false)
    // output comes as bytes
    await act(() => ws.receive(new TextEncoder().encode('more\r\n')))
    expect(screen.queryByRole('button', { name: '맨 아래로' })).toBeNull()
    const fresh = screen.getByRole('button', { name: '새 출력' })
    expect(fresh.classList.contains('btn-primary')).toBe(true)
    const [bottoms, focused] = [s.bottoms, s.focused]
    fireEvent.click(fresh)
    expect(s.bottoms).toBe(bottoms + 1)
    // the keys go back to the terminal
    expect(s.focused).toBe(focused + 1)
    expect(screen.queryByRole('button', { name: '새 출력' })).toBeNull()
    // scrolled back again, nothing new yet
    act(() => s.scrollTo(false))
    expect(screen.getByRole('button', { name: '맨 아래로' })).toBeTruthy()
  })

  it('types a key pressed outside the terminal into it, and leaves the keys of a field or a dialog', async () => {
    const { ws } = await mount()
    await attach(ws)
    const s = FakeScreen.last()
    const focused = s.focused
    fireEvent.keyDown(document.body, { key: 'y' })
    fireEvent.keyDown(document.body, { key: 'Enter' })
    expect(ws.input()).toEqual(['y', '\r'])
    expect(s.focused).toBe(focused + 2)
    // Escape closes what is open; a shortcut is the browser's
    fireEvent.keyDown(document.body, { key: 'Escape' })
    fireEvent.keyDown(document.body, { key: 'r', metaKey: true })
    // A button keeps the keys that press it; a letter still types.
    const stop = screen.getByRole('button', { name: '중단' })
    stop.focus()
    fireEvent.keyDown(stop, { key: 'Enter' })
    fireEvent.keyDown(stop, { key: ' ' })
    fireEvent.keyDown(stop, { key: 'n' })
    expect(ws.input()).toEqual(['y', '\r', 'n'])
    // A field keeps its keys.
    const box = screen.getByRole('textbox', { name: '터미널에 여러 줄 보내기' })
    box.focus()
    fireEvent.keyDown(box, { key: 'q' })
    // So does a dialog.
    fireEvent.click(screen.getByRole('button', { name: '종료' }))
    fireEvent.keyDown(document.body, { key: 'k' })
    expect(ws.input()).toEqual(['y', '\r', 'n'])
  })

  it('takes no stray keys while only watching', async () => {
    const { ws } = await mount()
    await attach(ws)
    fireEvent.click(screen.getByRole('button', { name: '보기 전용' }))
    const watch = FakeWebSocket.last()
    await attach(watch)
    fireEvent.keyDown(document.body, { key: 'y' })
    expect(watch.input()).toEqual([])
    expect(ws.input()).toEqual([])
  })

  it('draws with the letters picked in 설정 for a PC', async () => {
    localStorage.setItem('mori.font', JSON.stringify({ pc: 15, phone: 11 }))
    resetTermFont()
    await mount()
    expect(vi.mocked(openScreen).mock.lastCall![1].fontSize).toBe(15)
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

describe('The slash list', () => {
  const commands = {
    commands: [
      { name: 'clear', desc: '맥락을 비우고 새 대화를 시작합니다', hint: '[name]', source: 'builtin', aliases: ['reset', 'new'] },
      { name: 'compact', desc: '대화를 요약해 맥락 공간을 비웁니다', hint: '[instructions]', source: 'builtin' },
      { name: 'model', desc: '모델을 바꿉니다', hint: '[model]', source: 'builtin', menu: true },
      { name: 'deploy', desc: '스테이징에 배포합니다', source: 'project' },
      { name: 'tidy-up', desc: '코드를 정리합니다', source: 'user', skill: true },
    ],
    partial: false,
  }
  const box = () => screen.getByRole('textbox', { name: '터미널에 여러 줄 보내기' }) as HTMLTextAreaElement
  const rows = (lb: HTMLElement) => within(lb).getAllByRole('option').map((o) => o.querySelector('.term-slash-name')!.textContent)
  const type = (value: string) => fireEvent.input(box(), { target: { value } })

  beforeEach(() => {
    reply = (c) => (c.url === '/api/terminals/t1/commands' ? Response.json(commands) : undefined)
  })

  it('lists the commands of a Claude Code terminal on a "/" at the start', async () => {
    await mount()
    type('/')
    const lb = await screen.findByRole('listbox', { name: '슬래시 명령' })
    expect(rows(lb)).toEqual(['/compact', '/clear', '/model', '/deploy', '/tidy-up'])
    const [compact, clear, model, deploy, tidy] = within(lb).getAllByRole('option')
    expect(clear.textContent).toContain('(/reset /new)')
    expect(clear.textContent).toContain('[name]')
    expect(model.querySelector('.term-slash-menu')?.textContent).toBe('메뉴')
    expect(deploy.querySelector('.term-slash-src')?.textContent).toBe('프로젝트')
    expect(tidy.querySelector('.term-slash-src')?.textContent).toBe('스킬')
    expect(compact.querySelector('.term-slash-src')).toBeNull()
    expect(compact.getAttribute('aria-selected')).toBe('true')
    expect(box().getAttribute('aria-activedescendant')).toBe(compact.id)
    expect(box().getAttribute('aria-controls')).toBe(lb.id)
    // narrowed by what follows, an alias as well
    type('/res')
    await vi.waitFor(() => expect(rows(screen.getByRole('listbox'))).toEqual(['/clear']))
    type('/nothing')
    expect(await screen.findByText('맞는 명령이 없습니다')).toBeTruthy()
    // not inside a text
    type('fix /compact')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(sent('/api/terminals/t1/commands', 'GET')).toHaveLength(1) // kept a while
  })

  it('moves with the arrows and puts the name in the box with Enter, without sending it', async () => {
    await mount()
    type('/')
    const lb = await screen.findByRole('listbox')
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    expect(within(lb).getAllByRole('option')[1].getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(box(), { key: 'ArrowUp' })
    fireEvent.keyDown(box(), { key: 'ArrowUp' })
    expect(within(lb).getAllByRole('option')[4].getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(box(), { key: 'ArrowUp' })
    fireEvent.keyDown(box(), { key: 'ArrowUp' })
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(box().value).toBe('/model ')
    expect(box().selectionStart).toBe(7)
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(toasts.value.map((t) => t.text)).toEqual(['/model: 보내면 아래에 고르는 목록이 뜹니다'])
    expect(sent('/api/terminals/t1/send')).toEqual([])
    // Tab does the same, and a tap; what came after the word stays
    type('/co')
    await screen.findByRole('listbox')
    fireEvent.keyDown(box(), { key: 'Tab' })
    expect(box().value).toBe('/compact ')
    type('/de 지금')
    box().setSelectionRange(3, 3)
    fireEvent.keyUp(box(), { key: 'ArrowLeft' })
    fireEvent.click(within(await screen.findByRole('listbox')).getByText('/deploy'))
    expect(box().value).toBe('/deploy 지금')
  })

  // A window the panel does not read yet opens in the terminal (pickers design §12).
  it('tells a window the list will not show', async () => {
    const config = { name: 'config', desc: '설정을 엽니다', source: 'builtin', menu: true }
    reply = (c) =>
      c.url === '/api/terminals/t1/commands' ? Response.json({ ...commands, commands: [...commands.commands, config] }) : undefined
    await mount()
    type('/conf')
    await screen.findByRole('listbox')
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(box().value).toBe('/config ')
    expect(toasts.value.map((t) => t.text)).toEqual(['/config: 보내면 터미널에 창이 열립니다'])
  })

  it('tells the terminal when the setting is off', async () => {
    setPickOn(false)
    await mount()
    type('/mo')
    await screen.findByRole('listbox')
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(box().value).toBe('/model ')
    expect(toasts.value.map((t) => t.text)).toEqual(['/model: 보내면 터미널에 창이 열립니다'])
  })

  it('closes with Esc until the text changes, and sends with ⌘ or Ctrl + Enter as before', async () => {
    await mount()
    type('/dep')
    await screen.findByRole('listbox')
    fireEvent.keyDown(box(), { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    type('/depl')
    await screen.findByRole('listbox')
    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true })
    expect(box().value).toBe('/depl')
    type('/deploy')
    fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true })
    await vi.waitFor(() => expect(box().value).toBe(''))
    expect(sent('/api/terminals/t1/send').map((c) => c.body)).toEqual([{ text: '/deploy' }])
    // this device sent it lately: it comes first
    type('/')
    expect(rows(await screen.findByRole('listbox'))[0]).toBe('/deploy')
  })

  it('opens again after Esc once the text has changed, even back to what it was', async () => {
    await mount()
    type('/')
    await screen.findByRole('listbox')
    fireEvent.keyDown(box(), { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    // the "/" taken out and typed again
    type('')
    type('/')
    expect(await screen.findByRole('listbox')).toBeTruthy()
  })

  it('says when the list could not be read or is not all there', async () => {
    reply = (c) =>
      c.url === '/api/terminals/t1/commands' ? Response.json({ error: { kind: 'internal', message: '읽지 못했습니다' } }, { status: 500 }) : undefined
    await mount()
    type('/')
    expect(await screen.findByText('명령 목록을 읽지 못했습니다: 읽지 못했습니다')).toBeTruthy()
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(box().getAttribute('aria-activedescendant')).toBeNull()
    cleanup()
    reply = (c) => (c.url === '/api/terminals/t1/commands' ? Response.json({ ...commands, partial: true }) : undefined)
    await mount()
    type('/')
    expect(await screen.findByText('일부만 읽었습니다 — 여기 없는 명령도 쓸 수 있습니다')).toBeTruthy()
  })

  it('shows so many rows and counts the rest', async () => {
    const many = Array.from({ length: 85 }, (_, i) => ({ name: `c${String(i).padStart(2, '0')}`, desc: '', source: 'builtin' }))
    reply = (c) => (c.url === '/api/terminals/t1/commands' ? Response.json({ commands: many, partial: false }) : undefined)
    await mount()
    type('/')
    expect(within(await screen.findByRole('listbox')).getAllByRole('option')).toHaveLength(80)
    expect(screen.getByText('5개 더 — 더 적어서 좁히세요')).toBeTruthy()
  })

  it('stays away from a terminal that does not run Claude Code', async () => {
    await mount(term({ argv: ['/bin/zsh'], preset: undefined, display_title: 'zsh' }))
    type('/')
    await act(() => Promise.resolve())
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(box().hasAttribute('aria-autocomplete')).toBe(false)
    expect(sent('/api/terminals/t1/commands', 'GET')).toEqual([])
  })
})

describe('Looking at a session', () => {
  let close: ReturnType<typeof vi.fn>
  let getNotifications: ReturnType<typeof vi.fn>

  beforeEach(() => {
    resetSeen()
    close = vi.fn()
    getNotifications = vi.fn(async () => [{ close }])
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistration: async () => ({ getNotifications }) },
    })
  })

  afterEach(() => {
    delete (navigator as { serviceWorker?: unknown }).serviceWorker
    resetSeen()
  })

  const done = (over: Partial<TerminalView> = {}) => term({ status: status('done'), status_ms: 10 * HOUR - 60_000, turn: 2, ...over })

  it('sees its finish and closes its notifications while a person looks', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await mount(done())
    await vi.waitFor(() => expect(close).toHaveBeenCalled())
    expect(getNotifications).toHaveBeenCalledWith({ tag: 't1' })
    expect(JSON.parse(localStorage.getItem('mori.seen')!)['|t1']).toMatchObject({ c: 1000, turn: 2 })
  })

  it('sees the next finish as it ends', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await mount(done())
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1))
    act(() => {
      terminals.value = new Map([['t1', done({ turn: 3 })]])
    })
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(2))
    expect(seenMarks.value['|t1'].turn).toBe(3)
  })

  it('leaves them while nobody looks, until the window has the focus', async () => {
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    await mount(done())
    await Promise.resolve()
    expect(localStorage.getItem('mori.seen')).toBeNull()
    expect(getNotifications).not.toHaveBeenCalled()
    focus.mockReturnValue(true)
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await vi.waitFor(() => expect(close).toHaveBeenCalled())
    expect(seenMarks.value['|t1']).toMatchObject({ turn: 2 })
  })

  it("closes a host's notifications by that host's tag", async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const s = withHost()
    s.terminals.value = new Map([['t1', done()]])
    s.folders.value = [folder()]
    s.ready.value = true
    render(inHost(s, <Terminal addr="t1" variant="pc" />))
    await vi.waitFor(() => expect(getNotifications).toHaveBeenCalledWith({ tag: 'h_desk0001/t1' }))
    expect(seenMarks.value['h_desk0001|t1']).toMatchObject({ turn: 2 })
    expect(seenMarks.value['|t1']).toBeUndefined()
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
    expect(names).toEqual(['Esc', 'Ctrl', 'Alt', 'Tab', 'Shift+Tab', '위 화살표', '아래 화살표', '왼쪽 화살표', '오른쪽 화살표', 'Enter', 'Ctrl+C'])
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

  it('holds Ctrl or Alt for the next key, and on when tapped twice', async () => {
    const { ws } = await phone()
    await attach(ws)
    const keys = screen.getByRole('region', { name: '빠른 키' })
    const ctrl = within(keys).getByRole('button', { name: 'Ctrl' })
    expect(ctrl.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(ctrl)
    expect(ctrl.getAttribute('aria-pressed')).toBe('true')
    act(() => FakeScreen.last().type('c'))
    expect(ctrl.getAttribute('aria-pressed')).toBe('false')
    // tapped twice it stays on, until it is tapped again
    fireEvent.click(ctrl)
    fireEvent.click(ctrl)
    const held = within(keys).getByRole('button', { name: 'Ctrl 고정' })
    expect(held.hasAttribute('data-lock')).toBe(true)
    act(() => FakeScreen.last().type('a'))
    act(() => FakeScreen.last().type('e'))
    expect(held.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(held)
    expect(within(keys).getByRole('button', { name: 'Ctrl' }).getAttribute('aria-pressed')).toBe('false')
    // Alt with a quick key
    fireEvent.click(within(keys).getByRole('button', { name: 'Alt' }))
    fireEvent.click(within(keys).getByRole('button', { name: '왼쪽 화살표' }))
    act(() => FakeScreen.last().type('b'))
    expect(ws.input()).toEqual(['\x03', '\x01', '\x05', '\x1b[1;3D', 'b'])
  })

  it('shows two lines of a long question until it is opened', async () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(80)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(36)
    const long = 'Bash(rm -rf node_modules && npm ci && npm test -- --run --reporter verbose)를 실행할까요?'
    await phone(term({ status: status('blocked', { msg: long }) }))
    const ask = screen.getByRole('region', { name: '승인 대기 — 키로 응답' })
    const more = within(ask).getByRole('button', { name: '전체 보기' })
    const msg = within(ask).getByText(long)
    expect(more.getAttribute('aria-expanded')).toBe('false')
    expect(more.getAttribute('aria-controls')).toBe(msg.id)
    fireEvent.click(more)
    expect(more.textContent).toBe('접기')
    expect(more.getAttribute('aria-expanded')).toBe('true')
    expect(msg.classList.contains('is-open')).toBe(true)
    fireEvent.click(more)
    expect(msg.classList.contains('is-open')).toBe(false)
  })

  it('has nothing to open for a short question', async () => {
    await phone(term({ status: status('blocked', { msg: '파일을 고칠까요?' }) }))
    expect(screen.queryByRole('button', { name: '전체 보기' })).toBeNull()
  })

  it('changes the letters\' size from its menu, and the terminal follows the cells', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(840)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(425)
    const { ws } = await phone()
    // (840 − 14) / 8 and 425 / 17 at 12 px
    await attach(ws, 103, 25)
    expect(FakeScreen.last().fontSize).toBe(12)
    fireEvent.click(screen.getByRole('button', { name: '더 보기' }))
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: '글자 크기' }))
    const sheet = screen.getByRole('dialog', { name: '글자 크기' })
    const sizes = within(sheet).getByRole('group', { name: '터미널 글자 크기' })
    expect(within(sizes).getByRole('button', { name: '12' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(within(sizes).getByRole('button', { name: '14' }))
    await vi.waitFor(() => expect(ws.messages().filter((m) => m.type === 'resize')).toEqual([{ type: 'resize', cols: 88, rows: 21 }]))
    expect(FakeScreen.last().fontSize).toBe(14)
    expect(within(sizes).getByRole('button', { name: '14' }).getAttribute('aria-pressed')).toBe('true')
    expect(JSON.parse(localStorage.getItem('mori.font')!)).toEqual({ phone: 14 })
    // the same screen, not a new one
    expect(FakeScreen.all).toHaveLength(1)
    // back to the default: nothing is kept
    fireEvent.click(within(sizes).getByRole('button', { name: '12' }))
    await vi.waitFor(() => expect(FakeScreen.last().fontSize).toBe(12))
    expect(JSON.parse(localStorage.getItem('mori.font')!)).toEqual({})
  })

  it('answers a blocked program from four big keys', async () => {
    await phone(term({ status: status('blocked', { msg: '파일을 고칠까요?' }) }))
    const ask = screen.getByRole('region', { name: '승인 대기 — 키로 응답' })
    expect(within(ask).getByText('파일을 고칠까요?')).toBeTruthy()
    expect(within(ask).getAllByRole('button').map((b) => b.textContent)).toEqual(['1', '2', '3', 'Esc'])
  })

  it('turns a question down from a wide key under the four', async () => {
    await phone(term({ status: status('blocked', { msg: '파일을 고칠까요?' }), ask: '2.0badc0de' }))
    const ask = screen.getByRole('region', { name: '승인 대기 — 키로 응답' })
    expect(within(ask).getAllByRole('button').map((b) => b.textContent)).toEqual(['1', '2', '3', 'Esc', '거절하고 지시'])
    fireEvent.click(within(ask).getByRole('button', { name: '거절하고 지시' }))
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '거절하고 대신 보낼 글' }))
    expect(screen.getByRole('button', { name: '거절하고 보내기' })).toBeTruthy()
  })

  it('keeps the other tools in its menu', async () => {
    const { ws } = await phone()
    await attach(ws)
    fireEvent.click(screen.getByRole('button', { name: '더 보기' }))
    const menu = screen.getByRole('menu')
    expect(items(menu)).toEqual(['파일 올리기', '보기 전용', '이름 바꾸기', '중단', '글자 크기', '종료'])
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
    expect(items(screen.getByRole('menu'))).toEqual(['이름 바꾸기', '글자 크기', '목록에서 지우기'])
    fireEvent.click(screen.getAllByRole('button', { name: '목록에서 지우기' })[0])
    await vi.waitFor(() => expect(route.value).toEqual({ name: 'folders' }))
  })
})
