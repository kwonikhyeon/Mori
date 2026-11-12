import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeScreen } from '../../test/fakeScreen'
import { FakeWebSocket } from '../../test/fakeWs'
import { folder, status, term } from '../../test/fixtures'
import { inHost, withHost } from '../../test/scopes'
import { CHAT, cursorAt, SCREENS } from '../../test/screens'
import { now } from '../lib/clock'
import { resetBoxPref, setBoxShown } from '../lib/coverpref'
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

/** Opens 더 보기 and gives its item: where a PC keeps the tools it uses less (spec §3 #234). */
const more = (role: 'menuitem' | 'menuitemcheckbox', name: string) => {
  fireEvent.click(screen.getByRole('button', { name: '더 보기' }))
  return screen.getByRole(role, { name })
}

const sent = (path: string, method = 'POST') => calls.filter((c) => c.url === path && c.method === method)

beforeEach(() => {
  localStorage.clear()
  forgetCommands()
  resetTermFont()
  resetPickPref()
  resetBoxPref()
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
    // The tools used most are icons; the rest wait in 더 보기, by the view and by the session.
    for (const name of ['파일 올리기', 'Git', '종료', '더 보기']) expect(screen.getByRole('button', { name })).toBeTruthy()
    for (const name of ['보기 전용', '중단', '이름 바꾸기']) expect(screen.queryByRole('button', { name })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '더 보기' }))
    const menu = screen.getByRole('menu', { name: '더 보기' })
    expect(items(within(menu).getByRole('group', { name: '보기' }))).toEqual(['터미널 입력칸 보기', '보기 전용'])
    expect(items(within(menu).getByRole('group', { name: '세션' }))).toEqual(['이름 바꾸기', '중단'])
    expect(within(menu).getByRole('menuitemcheckbox', { name: '보기 전용' }).getAttribute('aria-checked')).toBe('false')
    fireEvent.keyDown(menu, { key: 'Escape' })
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
    fireEvent.click(more('menuitem', '중단'))
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

  // A Claude Code question's choices are on the terminal right above: the bar
  // says only what is asked (spec §3 #238).
  it("says a question without its choices", async () => {
    await mount(term({ status: status('blocked', { kind: 'question', msg: 'answer: 어떤 반려동물을 좋아하시나요? (Cat · Dog · Bird)' }), ask: '7.f01ce560' }))
    const ask = screen.getByRole('region', { name: '승인 대기 — 키로 응답' })
    expect(ask.querySelector('.term-ask-msg')?.textContent).toBe(' · 어떤 반려동물을 좋아하시나요?')
    expect(ask.textContent).not.toMatch(/Cat|answer:/)
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

  it('interrupts from 더 보기', async () => {
    await mount()
    fireEvent.click(more('menuitem', '중단'))
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
    fireEvent.click(more('menuitem', '이름 바꾸기'))
    let field = screen.getByRole('textbox', { name: '세션 이름' }) as HTMLInputElement
    expect(field.value).toBe('Claude Code')
    expect(document.activeElement).toBe(field)
    fireEvent.input(field, { target: { value: '리뷰' } })
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(screen.getByRole('heading', { level: 1, name: 'Claude Code' })).toBeTruthy()
    expect(calls.filter((c) => c.method === 'PATCH')).toEqual([])

    fireEvent.click(more('menuitem', '이름 바꾸기'))
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

  // An image copied to the clipboard, pasted into the box: it is uploaded, and
  // its path goes where the caret is, for Claude Code to read (spec §3 #220).
  it('pastes an image into the box as the path it is uploaded to', async () => {
    let n = 0
    reply = (c) => (c.url.endsWith('/files') ? Response.json({ path: `/Users/me/dev/Mori/.mori/up/p${++n}.png`, bytes: 3 }) : undefined)
    const { ws } = await mount()
    await attach(ws)
    const box = screen.getByRole('textbox', { name: '터미널에 여러 줄 보내기' }) as HTMLTextAreaElement
    fireEvent.input(box, { target: { value: '이 둘을 봐' } })
    box.setSelectionRange(5, 5)
    const shot = (name: string) => new File(['png'], name, { type: 'image/png' })
    const files = [shot('image.png'), shot('image.png')]
    expect(fireEvent.paste(box, { clipboardData: { files, types: ['Files'], getData: () => '' } })).toBe(false)
    await vi.waitFor(() => expect(box.value).toBe('이 둘을 /Users/me/dev/Mori/.mori/up/p1.png /Users/me/dev/Mori/.mori/up/p2.png 봐'))
    // named by the time, as a clipboard calls every image image.png
    const names = sent('/api/terminals/t1/files').map((c) => ((c.body as FormData).get('file') as File).name)
    expect(names[0]).toMatch(/^paste-\d{8}-\d{6}\.png$/)
    expect(names[1]).toBe(names[0].replace('.png', '-2.png'))
    // nothing typed into the terminal, and the text stays this device's draft
    expect(ws.input()).toEqual([])
    expect(sent('/api/terminals/t1/send')).toEqual([])
  })

  // One line high, as its button; it grows with its text (spec §3 #222).
  it('starts the box one line high', async () => {
    const { ws } = await mount()
    await attach(ws)
    expect((screen.getByRole('textbox', { name: '터미널에 여러 줄 보내기' }) as HTMLTextAreaElement).rows).toBe(1)
  })

  // A spreadsheet's cells come as text and as a picture of them: the text goes in.
  it('leaves a paste with text to the box', async () => {
    const { ws } = await mount()
    await attach(ws)
    const box = screen.getByRole('textbox', { name: '터미널에 여러 줄 보내기' })
    const files = [new File(['png'], 'image.png', { type: 'image/png' })]
    const getData = (t: string) => (t === 'text/plain' ? 'A1\tB1' : '')
    expect(fireEvent.paste(box, { clipboardData: { files, types: ['text/plain', 'Files'], getData } })).toBe(true)
    expect(sent('/api/terminals/t1/files')).toEqual([])
  })

  it('refuses a pasted image over 8 MB', async () => {
    const { ws } = await mount()
    await attach(ws)
    const box = screen.getByRole('textbox', { name: '터미널에 여러 줄 보내기' })
    const big = new File(['x'], 'image.png', { type: 'image/png' })
    Object.defineProperty(big, 'size', { value: 9 << 20 })
    fireEvent.paste(box, { clipboardData: { files: [big], types: ['Files'], getData: () => '' } })
    await vi.waitFor(() => expect(toasts.value.map((t) => [t.text, t.kind])).toEqual([['image.png: 8 MB를 넘는 파일은 올릴 수 없습니다', 'error']]))
    expect(sent('/api/terminals/t1/files')).toEqual([])
  })

  it('only watches: attaches again as an observer and stops typing', async () => {
    const { ws } = await mount()
    await attach(ws)
    fireEvent.click(more('menuitemcheckbox', '보기 전용'))
    const watch = FakeWebSocket.last()
    expect(watch).not.toBe(ws)
    expect(ws.closedWith).not.toBeNull()
    expect(watch.query().get('observe')).toBe('1')
    expect(watch.query().get('cols')).toBeNull()
    await attach(watch)
    expect(more('menuitemcheckbox', '보기 전용').getAttribute('aria-checked')).toBe('true')
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
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
    const upload = screen.getByRole('button', { name: '파일 올리기' })
    upload.focus()
    fireEvent.keyDown(upload, { key: 'Enter' })
    fireEvent.keyDown(upload, { key: ' ' })
    fireEvent.keyDown(upload, { key: 'n' })
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
    fireEvent.click(more('menuitemcheckbox', '보기 전용'))
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
    expect(items(menu)).toEqual(['파일 올리기', '보기 전용', '터미널 입력칸 보기', '이름 바꾸기', '중단', '글자 크기', '종료'])
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

describe('pickers', () => {
  const TITLE = 'Select model Switch between Claude models. Applies to this session and future sessions.'
  const ASK = '3.0badc0de'
  // half drawn, as the terminal shows it for a moment while it redraws: no window and no input box
  const half = SCREENS.model.split('\n').slice(0, 3).join('\n') + '\n'
  const frame = (ms = 20) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  const show = async (text: string) => {
    act(() => FakeScreen.last().show(text))
    await frame()
  }
  const panel = () => document.querySelector<HTMLElement>('.term-pick')
  const live = () => document.querySelector('[data-mori-live="polite"]')
  const said = () => live()?.textContent ?? ''
  const rowsOf = (el: HTMLElement) => [...el.querySelectorAll<HTMLButtonElement>('.term-pick-row')]
  const hintsOf = (el: HTMLElement) => [...el.querySelectorAll<HTMLButtonElement>('.term-pick-hints button')]
  const titles = (el: HTMLElement) => rowsOf(el).map((r) => r.querySelector('.qrow-title')?.textContent)
  /** The approval bar's keys for a window's items: their numbers, named by what they say (spec §3 #238). */
  const itemsOf = (el: HTMLElement) => [...el.querySelectorAll<HTMLButtonElement>('.term-ask-key[aria-label]')]
  const blockedTerm = () => term({ status: status('blocked', { kind: 'permission', msg: 'Bash(ls)를 실행할까요?' }), ask: ASK })
  /**
   * Heights a browser would lay out, by class, in px, or worked out from the
   * element as it is drawn; the record may change as a test goes on.
   */
  const layOut = (px: Record<string, number | ((el: HTMLElement) => number)>) => {
    const of = (el: HTMLElement) => {
      const h = Object.entries(px).find(([c]) => el.classList.contains(c))?.[1] ?? 0
      return typeof h === 'function' ? h(el) : h
    }
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return of(this)
    })
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return of(this)
    })
    return px
  }
  const capIn = (sel: string) => document.querySelector<HTMLElement>(`${sel} .term-pick-body`)?.style.maxHeight

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'Date'],
    })
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('shows the list of a window at the bottom', async () => {
    const { ws } = await mount()
    await attach(ws)
    await show(SCREENS.model)
    const p = screen.getByRole('region', { name: TITLE })
    expect(titles(p)).toEqual(['Default (recommended)', 'Sonnet', 'Haiku'])
    const rows = rowsOf(p)
    expect(rows[0].getAttribute('aria-current')).toBe('true')
    expect(rows[0].classList.contains('is-selected')).toBe(true)
    expect(rows[1].hasAttribute('aria-current')).toBe(false)
    expect(rows[1].classList.contains('is-selected')).toBe(false)
    // the item in use says so in words, not in a colour alone (design §6.4)
    expect(rows[0].querySelector('.term-pick-mark')?.textContent).toBe('지금 쓰는 것')
    expect(rows[1].querySelector('.term-pick-mark')).toBeNull()
    expect(hintsOf(p).map((b) => b.textContent)).toEqual(['고르기', '노력 낮추기', '노력 높이기', '이 세션만', '닫기'])
    expect([...rows, ...hintsOf(p)].every((b) => !b.disabled)).toBe(true)
    // laid over the bottom of the terminal, which keeps its size, and scrolled inside its cap
    expect(p.parentElement?.classList.contains('term-stage')).toBe(true)
    expect(p.querySelector<HTMLElement>('.term-pick-body')?.style.maxHeight).toBe('120px')
    await frame()
    expect(said()).toBe(`고르는 목록: ${TITLE}`)
  })

  it("caps the list at what the stage holds beside the panel's title and keys", async () => {
    layOut({ 'term-stage': 300, 'term-pick': 200, 'term-pick-body': 100 })
    const { ws } = await mount()
    await attach(ws)
    await show(SCREENS.model)
    // the stage, less the panel's own 200 − 100: the terminal keeps its rows under the panel
    expect(capIn('.term-pick')).toBe('200px')
  })

  // Blocked on it, the window goes from its panel to the approval bar, as
  // keys by its items' numbers: no list, as the terminal shows it (spec §3 #238).
  it('moves the window from its panel to the bar, as keys, when the program blocks on it', async () => {
    layOut({ 'term-stage': 300, 'term-pick': 200, 'term-pick-body': 100 })
    const { ws } = await mount()
    await attach(ws)
    await show(SCREENS.permission)
    // 300 − (200 − 100)
    expect(capIn('.term-pick')).toBe('200px')
    act(() => load([blockedTerm()]))
    await frame()
    expect(panel()).toBeNull()
    const ask = screen.getByRole('region', { name: '승인 대기 — 골라서 응답' })
    expect(itemsOf(ask).map((b) => b.textContent)).toEqual(['1', '2', '3'])
    expect(ask.querySelector('.term-pick-body, .term-pick-row')).toBeNull()
  })

  // A panel without its list would hide the window it stands for: where the
  // list cannot show, no panel shows, and the terminal shows the window.
  it('shows no panel where its list cannot show, and comes as the stage grows', async () => {
    const px = layOut({ 'term-stage': 150, 'term-pick': 140, 'term-pick-body': 100 })
    const { ws } = await mount()
    await attach(ws)
    await show(SCREENS.model)
    // 150 − (140 − 100) is under MIN_CAP
    expect(panel()).toBeNull()
    // a send still closes the window first
    expect(screen.getByRole('button', { name: '닫고 보내기' })).toBeTruthy()
    await frame()
    // read out once, and that it is answered on the terminal
    expect(said()).toBe(`고르는 목록: ${TITLE} 자리가 모자라 터미널에서 고릅니다`)
    // the stage grows, as a phone's keyboard goes down: the panel comes, with its list
    px['term-stage'] = 400
    await act(() => ws.json({ type: 'size', cols: 80, rows: 30 }))
    await frame()
    // 400 − 40
    expect(capIn('.term-pick')).toBe('360px')
  })

  // The bar's keys need no list's room: a terminal that could not spare it
  // still has the items' keys, and shows the list itself.
  it('answers a blocked list by its items where the terminal cannot spare a list its room', async () => {
    layOut({ 'term-stage': 150, 'term-ask': 200, 'term-pick-body': 100 })
    const { ws } = await mount(blockedTerm())
    await attach(ws)
    await show(SCREENS.permission)
    const ask = screen.getByRole('region', { name: '승인 대기 — 골라서 응답' })
    expect(within(ask).getAllByRole('button').map((b) => b.textContent)).toEqual(['1', '2', '3', 'Esc', '거절하고 지시', 'Ctrl+E · explain'])
    expect(document.querySelector('.term-pick, .term-pick-row')).toBeNull()
  })

  it('ends the title of a window the terminal kept with a period', async () => {
    layOut({
      'term-stage': 100,
      'term-pick': (el) => 40 + (el.querySelector('.term-pick-body') ? 100 : 0),
      'term-pick-body': 100,
    })
    const { ws } = await mount()
    await attach(ws)
    await show(SCREENS['long-list'])
    expect(panel()).toBeNull()
    await frame()
    expect(said()).toBe('고르는 목록: Pick a color theme. 자리가 모자라 터미널에서 고릅니다')
  })

  it('measures a window by its own title and keys after one the terminal kept', async () => {
    layOut({
      'term-stage': 200,
      // 20px for the title, and 20px for each key
      'term-pick': (el) => 20 + 20 * el.querySelectorAll('.term-pick-hints button').length + (el.querySelector('.term-pick-body') ? 100 : 0),
      'term-pick-body': 100,
    })
    const { ws } = await mount()
    await attach(ws)
    await show(SCREENS.model)
    // /model's five keys: 200 − 120 is under MIN_CAP
    expect(panel()).toBeNull()
    await show(SCREENS.idle)
    await show(SCREENS.permission)
    // its own two keys, not /model's five: 200 − 60
    expect(capIn('.term-pick')).toBe('140px')
    expect(hintsOf(panel()!).map((b) => b.textContent)).toEqual(['닫기', 'Ctrl+E · explain'])
  })

  // Claude Code draws only part of a list on a terminal too short for it
  // (… +4 models): a panel would show that part, over the terminal's.
  it('shows no panel for a list Claude Code cut short', async () => {
    const { ws } = await mount()
    await attach(ws)
    await show(SCREENS['model-cc-short'])
    expect(panel()).toBeNull()
    expect(screen.getByRole('button', { name: '닫고 보내기' })).toBeTruthy()
    await frame()
    expect(said()).toBe('고르는 목록: Select model Switch between Claude models. Your pick becomes the default for new sessions. 자리가 모자라 터미널에서 고릅니다')
    // drawn whole, it shows
    await show(SCREENS['model-cc'])
    expect(titles(panel()!)).toEqual(['Default (recommended)', 'Opus 5.5', 'Fable 5.2', 'Sonnet 5.5', 'Haiku 5.5'])
  })

  // The bar takes rows from the terminal, where Claude Code may draw the list
  // again cut short: the bar answers by its own keys for the rest of the
  // question, so that its height does not go back and forth.
  it('keeps a blocked list cut short out of the bar for its question', async () => {
    const { ws } = await mount(blockedTerm())
    await attach(ws)
    const items = () => itemsOf(document.querySelector<HTMLElement>('.term-ask')!).length
    await show(SCREENS['model-cc'])
    expect(items()).toBe(5)
    await show(SCREENS['model-cc-short'])
    expect(screen.getByRole('region', { name: '승인 대기 — 키로 응답' })).toBeTruthy()
    await show(SCREENS['model-cc'])
    expect(items()).toBe(0)
    // another question takes its items again
    act(() => load([term({ status: status('blocked', { kind: 'permission', msg: '다른 질문' }), ask: '4.0badc0de' })]))
    await frame()
    expect(items()).toBe(5)
  })

  it('shows nothing while idle', async () => {
    const { ws } = await mount()
    await attach(ws)
    await show(SCREENS.idle)
    expect(panel()).toBeNull()
    // the reading is live: a window drawn now shows
    await show(SCREENS.model)
    expect(panel()).not.toBeNull()
  })

  it('shows no panel for an answer list', async () => {
    const { ws } = await mount()
    await attach(ws)
    await show(SCREENS['answer-list'])
    expect(panel()).toBeNull()
    await show(SCREENS.model)
    expect(panel()).not.toBeNull()
  })

  it('shows no panel for a typed list', async () => {
    const { ws } = await mount()
    await attach(ws)
    await show(SCREENS['typed-list'])
    expect(panel()).toBeNull()
    await show(SCREENS.model)
    expect(panel()).not.toBeNull()
  })

  it('does not flap through a redraw', async () => {
    const { ws } = await mount()
    await attach(ws)
    await show(SCREENS.model)
    await frame()
    expect(said()).toBe(`고르는 목록: ${TITLE}`)
    // the terminal redraws at a new size and shows no window for a moment
    await act(() => ws.json({ type: 'size', cols: 80, rows: 20 }))
    await show(half)
    const p = screen.getByRole('region', { name: TITLE })
    expect([...rowsOf(p), ...hintsOf(p)].every((b) => b.disabled)).toBe(true)
    live()!.textContent = ''
    await show(SCREENS.model)
    await frame()
    expect(screen.getByRole('region', { name: TITLE })).toBe(p)
    expect([...rowsOf(p), ...hintsOf(p)].every((b) => !b.disabled)).toBe(true)
    // the same window, so it is not read out again
    expect(said()).toBe('')
  })

  // The panel lies over the terminal and resizes nothing: a window lost
  // after a resize is not its doing, and shows again when drawn again.
  it('does not hold a window lost after a resize', async () => {
    const { ws } = await mount()
    await attach(ws)
    await show(SCREENS.model)
    await frame(2000)
    await act(() => ws.json({ type: 'size', cols: 80, rows: 20 }))
    await show(half)
    await frame(1000) // SETTLE_MS
    expect(panel()).toBeNull()
    await show(SCREENS.model)
    expect(screen.getByRole('region', { name: TITLE })).toBeTruthy()
  })

  // The approval bar takes rows from the terminal: a list lost after its
  // resize is likely its doing, and stays out of it until the box shows.
  it("holds a blocked list lost after the bar's resize until the box shows", async () => {
    const { ws } = await mount(blockedTerm())
    await attach(ws)
    await show(SCREENS.permission)
    const rows = () => itemsOf(document.querySelector<HTMLElement>('.term-ask')!).length
    expect(rows()).toBe(3)
    await frame(2000)
    await act(() => ws.json({ type: 'size', cols: 80, rows: 20 }))
    await show(SCREENS.permission.split('\n').slice(0, 3).join('\n') + '\n')
    await frame(1000) // SETTLE_MS
    expect(rows()).toBe(0)
    await show(SCREENS.permission)
    expect(rows()).toBe(0)
    await show(SCREENS.idle)
    await show(SCREENS.permission)
    expect(rows()).toBe(3)
  })

  // A resize redraws the window from its top down,
  // its title cut off for a moment: the window is the same (design §6.4).
  it('keeps the title of a window its redraw cuts', async () => {
    const { ws } = await mount()
    await attach(ws)
    await show(SCREENS.model)
    await frame()
    const p = screen.getByRole('region', { name: TITLE })
    live()!.textContent = ''
    await act(() => ws.json({ type: 'size', cols: 80, rows: 20 }))
    await show(SCREENS.model.split('\n').slice(3).join('\n'))
    expect(screen.getByRole('region', { name: TITLE })).toBe(p)
    expect([...rowsOf(p), ...hintsOf(p)].every((b) => !b.disabled)).toBe(true)
    await frame()
    expect(said()).toBe('')
  })

  // A question's cursor goes on to "Chat about this", a row without a number
  // below its items: the window stays, with no item under the cursor.
  it('keeps the panel when the cursor goes to a row without a number', async () => {
    const { ws } = await mount()
    await attach(ws)
    await show(SCREENS['ask-preview'])
    await frame()
    const p = screen.getByRole('region', { name: '어떤 색으로 칠할까요?' })
    live()!.textContent = ''
    await show(CHAT)
    expect(screen.getByRole('region', { name: '어떤 색으로 칠할까요?' })).toBe(p)
    expect(rowsOf(p)).toHaveLength(2)
    expect(rowsOf(p).some((r) => r.hasAttribute('aria-current'))).toBe(false)
    // moving counts from the item under the cursor, and there is none
    expect(rowsOf(p).every((r) => r.disabled)).toBe(true)
    expect(hintsOf(p).every((b) => !b.disabled)).toBe(true)
    await frame()
    expect(said()).toBe('')
  })

  it('answers a blocked question from a row without a number', async () => {
    const { ws } = await mount(blockedTerm())
    await attach(ws)
    await show(SCREENS['ask-preview'])
    await show(CHAT)
    const ask = screen.getByRole('region', { name: '승인 대기 — 골라서 응답' })
    expect(itemsOf(ask)).toHaveLength(2)
    // a blocked window takes the number, wherever its cursor stands
    expect(itemsOf(ask).every((r) => !r.disabled)).toBe(true)
  })

  it('turns off with the setting', async () => {
    const { ws } = await mount()
    await attach(ws)
    await show(SCREENS.model)
    expect(panel()).not.toBeNull()
    act(() => setPickOn(false))
    expect(panel()).toBeNull()
    // on again, it reads what the screen shows at once
    act(() => setPickOn(true))
    expect(screen.getByRole('region', { name: TITLE })).toBeTruthy()
  })

  it("shows an observed terminal's list with its buttons off", async () => {
    const { ws } = await mount()
    await attach(ws)
    fireEvent.click(more('menuitemcheckbox', '보기 전용'))
    const watch = FakeWebSocket.last()
    await attach(watch)
    await show(SCREENS.model)
    const p = screen.getByRole('region', { name: TITLE })
    const buttons = [...rowsOf(p), ...hintsOf(p)]
    expect(buttons).toHaveLength(8)
    expect(buttons.every((b) => b.disabled)).toBe(true)
  })

  // The items are keys by their numbers, named by what they say; the
  // terminal right above shows the list (spec §3 #238).
  it('answers a blocked window by its items, as keys', async () => {
    const { ws } = await mount(blockedTerm())
    await attach(ws)
    await show(SCREENS.permission)
    const ask = screen.getByRole('region', { name: '승인 대기 — 골라서 응답' })
    expect(itemsOf(ask).map((b) => [b.textContent, b.getAttribute('aria-label'), b.title])).toEqual([
      ['1', '1. Yes', 'Yes'],
      ['2', "2. Yes, and don't ask again for ls commands in /tmp/mori-sample", "Yes, and don't ask again for ls commands in /tmp/mori-sample"],
      ['3', '3. No, and tell Claude what to do differently (esc)', 'No, and tell Claude what to do differently (esc)'],
    ])
    expect(ask.querySelector('.term-pick-row, .qrow-title')).toBeNull()
    expect(within(ask).getByRole('button', { name: 'Esc' })).toBeTruthy()
    expect(within(ask).getByRole('button', { name: '거절하고 지시' })).toBeTruthy()
    // the bar's own number keys and Enter give way to the window's
    expect(within(ask).queryByRole('button', { name: 'Enter' })).toBeNull()
    expect(ask.querySelectorAll('.term-ask-key:not([aria-label])')).toHaveLength(1)
    // the window's Esc is the bar's own key
    expect(hintsOf(ask).map((b) => b.textContent)).toEqual(['Ctrl+E · explain'])
    // one bar, not a panel as well
    expect(panel()).toBeNull()
  })

  // A phone's bar has four keys a row: the window's items by their numbers,
  // then Esc; 거절하고 지시 takes a row of its own.
  it("puts the window's items in a phone's bar as keys, four a row", async () => {
    const { ws } = await mount(blockedTerm(), { variant: 'phone', back: '#/folders' })
    await attach(ws)
    await show(SCREENS.permission)
    const ask = screen.getByRole('region', { name: '승인 대기 — 골라서 응답' })
    const grid = ask.querySelector('.term-ask-grid')!
    expect([...grid.children].map((b) => b.textContent)).toEqual(['1', '2', '3', 'Esc', '거절하고 지시'])
    expect(ask.querySelector('.term-pick-row')).toBeNull()
  })

  it('keeps the keys for a blocked hint-only window', async () => {
    const { ws } = await mount(blockedTerm())
    await attach(ws)
    await show(SCREENS.btw)
    const ask = screen.getByRole('region', { name: '승인 대기 — 키로 응답' })
    expect(within(ask).getAllByRole('button').map((b) => b.textContent)).toEqual(['1', '2', '3', 'Enter', 'Esc', '거절하고 지시'])
    expect(document.querySelector('.term-pick, .term-pick-row')).toBeNull()
  })

  it('lays the panel over the terminal on a phone', async () => {
    const { ws } = await mount(undefined, { variant: 'phone', back: '#/folders' })
    await attach(ws)
    await show(SCREENS.model)
    const p = screen.getByRole('region', { name: TITLE })
    expect(p.parentElement?.classList.contains('term-stage')).toBe(true)
    expect(document.querySelector('.term-dock .term-pick')).toBeNull()
  })

  describe('pressing a window', () => {
    const DOWN = '\x1b[B'
    const BTW =
      '/btw 빗금 목록은 어디서 읽어?\n\n빗금 목록은 서버가 주는 명령 목록을 읽습니다.\n' +
      '입력창에서 빗금을 치면 그 목록에서 고릅니다.\n고른 명령은 입력창에 들어갑니다.'
    const keys = () => sent('/api/terminals/t1/keys').map((c) => c.body)
    const toasted = () => toasts.value.map((t) => [t.text, t.kind])
    const bar = () => screen.getByRole('region', { name: '승인 대기 — 골라서 응답' })
    const clipboard = (writeText: (text: string) => Promise<void>) => {
      vi.stubGlobal('isSecureContext', true)
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true, writable: true })
    }

    afterEach(() => {
      delete (navigator as { clipboard?: unknown }).clipboard
      delete (document as { execCommand?: unknown }).execCommand
    })

    it('blocked: a number carries expect', async () => {
      const { ws } = await mount(blockedTerm())
      await attach(ws)
      await show(SCREENS.permission)
      fireEvent.click(itemsOf(bar())[1])
      await vi.waitFor(() => expect(keys()).toEqual([{ keys: ['2'], expect: ASK }]))
      // not down the stream, where it could land on the next question
      expect(ws.input()).toEqual([])
    })

    it('blocked: moves go without expect', async () => {
      const { ws } = await mount(blockedTerm())
      await attach(ws)
      await show(SCREENS['long-list'])
      fireEvent.click(within(bar()).getByRole('button', { name: '아래 화살표' }))
      await vi.waitFor(() => expect(keys()).toEqual([{ keys: ['down'] }]))
      expect(ws.input()).toEqual([])
    })

    it('blocked: item 10 moves, sees, then Enter', async () => {
      const { ws } = await mount(blockedTerm())
      await attach(ws)
      await show(SCREENS['long-list'])
      fireEvent.click(itemsOf(bar())[9])
      await vi.waitFor(() => expect(keys()).toEqual([{ keys: Array(9).fill('down') }]))
      // no Enter until the cursor shows on it
      await frame()
      expect(keys()).toHaveLength(1)
      await show(cursorAt(SCREENS['long-list'], 10))
      await vi.waitFor(() => expect(keys()).toEqual([{ keys: Array(9).fill('down') }, { keys: ['enter'], expect: ASK }]))
      expect(ws.input()).toEqual([])
    })

    it('not blocked: arrows, then Enter once the cursor lands', async () => {
      const { ws } = await mount()
      await attach(ws)
      await show(SCREENS.model)
      fireEvent.click(rowsOf(panel()!)[2])
      await vi.waitFor(() => expect(ws.input()).toEqual([DOWN + DOWN]))
      // one press at a time: the buttons are off until it ends
      await frame()
      expect(rowsOf(panel()!).every((b) => b.disabled)).toBe(true)
      await show(cursorAt(SCREENS.model, 3))
      await vi.waitFor(() => expect(ws.input()).toEqual([DOWN + DOWN, '\r']))
      expect(keys()).toEqual([])
      await vi.waitFor(() => expect(rowsOf(panel()!).every((b) => !b.disabled)).toBe(true))
      expect(toasted()).toEqual([])
    })

    it('not blocked: a hint sends its key down the stream', async () => {
      const { ws } = await mount()
      await attach(ws)
      await show(SCREENS.model)
      fireEvent.click(within(panel()!).getByRole('button', { name: '노력 높이기' }))
      await vi.waitFor(() => expect(ws.input()).toEqual(['\x1b[C']))
      await vi.waitFor(() => expect(hintsOf(panel()!).every((b) => !b.disabled)).toBe(true))
      fireEvent.click(within(panel()!).getByRole('button', { name: '닫기' }))
      await vi.waitFor(() => expect(ws.input()).toEqual(['\x1b[C', '\x1b']))
      expect(keys()).toEqual([])
    })

    it('sends nothing when the list changed', async () => {
      const { ws } = await mount()
      await attach(ws)
      await show(SCREENS.model)
      const rows = rowsOf(panel()!)
      // the screen moved on, and the panel has not drawn it yet
      act(() => FakeScreen.last().show(cursorAt(SCREENS.model, 2)))
      fireEvent.click(rows[2])
      await vi.waitFor(() => expect(toasted()).toEqual([['목록이 바뀌어 고르지 않았습니다', 'error']]))
      expect(ws.input()).toEqual([])
      expect(keys()).toEqual([])
    })

    it('no landing, no Enter', async () => {
      const { ws } = await mount()
      await attach(ws)
      await show(SCREENS.model)
      fireEvent.click(rowsOf(panel()!)[2])
      await vi.waitFor(() => expect(ws.input()).toEqual([DOWN + DOWN]))
      // the cursor never shows on item 3
      await frame(1500) // SEE_MS
      await vi.waitFor(() => expect(toasted()).toEqual([['목록이 바뀌어 고르지 않았습니다', 'error']]))
      expect(ws.input()).toEqual([DOWN + DOWN])
    })

    it('copies what the screen shows', async () => {
      const writeText = vi.fn(async (_text: string) => undefined)
      clipboard(writeText)
      const { ws } = await mount()
      await attach(ws)
      await show(SCREENS.btw)
      fireEvent.click(within(panel()!).getByRole('button', { name: '복사' }))
      await vi.waitFor(() => expect(toasted()).toEqual([['화면에 보이는 부분만 복사했습니다', 'info']]))
      expect(writeText.mock.calls).toEqual([[BTW]])
      // Mori copies it: no key goes to the terminal
      expect(ws.input()).toEqual([])
      expect(keys()).toEqual([])
    })

    it('says when it could not copy', async () => {
      clipboard(async () => {
        throw new Error('refused')
      })
      Object.defineProperty(document, 'execCommand', { value: () => false, configurable: true })
      const { ws } = await mount()
      await attach(ws)
      await show(SCREENS.btw)
      fireEvent.click(within(panel()!).getByRole('button', { name: '복사' }))
      await vi.waitFor(() => expect(toasted()).toEqual([['복사하지 못했습니다', 'error']]))
    })
  })

  describe('close and send', () => {
    const STUCK = '창이 닫히지 않아 보내지 않았습니다'
    const textbox = () => screen.getByRole('textbox', { name: '터미널에 여러 줄 보내기' }) as HTMLTextAreaElement
    const sends = () => sent('/api/terminals/t1/send').map((c) => c.body)
    const stuck = () => document.querySelector('p.term-held')
    const loud = () => document.querySelector('[data-mori-live="assertive"]')?.textContent ?? ''

    it('names the send button for an open window', async () => {
      const { ws } = await mount()
      await attach(ws)
      await show(SCREENS.model)
      expect(screen.getByRole('button', { name: '닫고 보내기' })).toBeTruthy()
      expect(screen.queryByRole('button', { name: '보내기' })).toBeNull()
      await show(SCREENS.idle)
      expect(screen.getByRole('button', { name: '보내기' })).toBeTruthy()
      expect(screen.queryByRole('button', { name: '닫고 보내기' })).toBeNull()
    })

    it('closes, waits for the box, then sends', async () => {
      const { ws } = await mount()
      await attach(ws)
      await show(SCREENS.model)
      const box = textbox()
      fireEvent.input(box, { target: { value: '테스트 돌려줘' } })
      fireEvent.click(screen.getByRole('button', { name: '닫고 보내기' }))
      await vi.waitFor(() => expect(ws.input()).toEqual(['\x1b']))
      // nothing goes while the window shows
      await frame()
      expect(sends()).toEqual([])
      await show(SCREENS.idle)
      await vi.waitFor(() => expect(sends()).toEqual([{ text: '테스트 돌려줘' }]))
      await vi.waitFor(() => expect(box.value).toBe(''))
      expect(ws.input()).toEqual(['\x1b'])
      expect(sent('/api/terminals/t1/keys')).toEqual([])
      expect(stuck()).toBeNull()
    })

    // The panel's own cut keeps the window out of it, but the terminal still
    // shows the window: a send closes it first (design §14 #10).
    it('closes a window held out of the panel before it sends', async () => {
      const { ws } = await mount()
      await attach(ws)
      // lost as soon as it showed: held
      await show(SCREENS.model)
      await show(half)
      await frame(1000) // SETTLE_MS
      await show(SCREENS.model)
      expect(panel()).toBeNull()
      const box = textbox()
      fireEvent.input(box, { target: { value: '테스트 돌려줘' } })
      fireEvent.click(screen.getByRole('button', { name: '닫고 보내기' }))
      await vi.waitFor(() => expect(ws.input()).toEqual(['\x1b']))
      await frame()
      expect(sends()).toEqual([])
      await show(SCREENS.idle)
      await vi.waitFor(() => expect(sends()).toEqual([{ text: '테스트 돌려줘' }]))
      expect(stuck()).toBeNull()
    })

    it('keeps the text when the window stays', async () => {
      const { ws } = await mount()
      await attach(ws)
      await show(SCREENS.model)
      const box = textbox()
      fireEvent.input(box, { target: { value: 'go on' } })
      fireEvent.click(screen.getByRole('button', { name: '닫고 보내기' }))
      await vi.waitFor(() => expect(ws.input()).toEqual(['\x1b']))
      await frame(2000) // CLOSE_MS
      expect(stuck()?.textContent).toBe(STUCK)
      // spoken through announce(), not by a live region of its own
      expect(stuck()?.hasAttribute('role')).toBe(false)
      await frame()
      expect(loud()).toBe(STUCK)
      expect(box.value).toBe('go on')
      expect(sends()).toEqual([])
      // typing again takes the note away, as with a held send
      fireEvent.input(box, { target: { value: 'go on!' } })
      expect(stuck()).toBeNull()
      // and the window closing takes it too
      fireEvent.click(screen.getByRole('button', { name: '닫고 보내기' }))
      await frame(2000)
      expect(stuck()?.textContent).toBe(STUCK)
      await show(SCREENS.idle)
      expect(stuck()).toBeNull()
      expect(screen.getByRole('button', { name: '보내기' })).toBeTruthy()
      expect(sends()).toEqual([])
    })

    it('keeps the blocked path', async () => {
      reply = (c) =>
        c.url.endsWith('/send') ? Response.json({ error: { kind: 'blocked', message: '승인을 기다립니다' } }, { status: 409 }) : undefined
      const { ws } = await mount(blockedTerm())
      await attach(ws)
      await show(SCREENS.permission)
      expect(screen.queryByRole('button', { name: '닫고 보내기' })).toBeNull()
      const box = textbox()
      fireEvent.input(box, { target: { value: 'go on' } })
      fireEvent.click(screen.getByRole('button', { name: '보내기' }))
      await vi.waitFor(() => expect(document.querySelector('div.term-held')?.textContent).toContain('승인 대기 중 — 키로 응답'))
      expect(sends()).toEqual([{ text: 'go on' }])
      // no Esc: the approval bar and 거절하고 지시 answer a blocked window (spec §3 #195)
      expect(ws.input()).toEqual([])
      expect(sent('/api/terminals/t1/keys')).toEqual([])
      expect(box.value).toBe('go on')
      expect(stuck()).toBeNull()
    })
  })

  // ↑, ↓ and Enter in an empty box go to the window, as on the terminal; the
  // panel follows the terminal's cursor (pickers design §14 #45).
  describe('keys from the box', () => {
    const UP = '\x1b[A'
    const DOWN = '\x1b[B'
    // the box has the focus, as when one types in it
    const textbox = () => {
      const box = screen.getByRole('textbox', { name: '터미널에 여러 줄 보내기' }) as HTMLTextAreaElement
      box.focus()
      return box
    }

    it('moves the cursor with the arrows and chooses with Enter', async () => {
      const { ws } = await mount()
      await attach(ws)
      await show(SCREENS.model)
      const box = textbox()
      // handled: the box does not move its own caret
      expect(fireEvent.keyDown(box, { key: 'ArrowDown' })).toBe(false)
      expect(fireEvent.keyDown(box, { key: 'ArrowUp' })).toBe(false)
      expect(ws.input()).toEqual([DOWN, UP])
      expect(fireEvent.keyDown(box, { key: 'Enter' })).toBe(false)
      await vi.waitFor(() => expect(ws.input()).toEqual([DOWN, UP, '\r']))
    })

    // The core answers a send once it has watched for a turn to start, some
    // 5s for a command that starts none, as /model: the box holds the text it
    // sent until then, though the window showed long before (pickers design §14 #45).
    // The box still holds "/model" then, and the slash list would open over
    // it and take the keys: it stays shut while the box sends.
    it('sends the keys while the box is still sending what opened the window', async () => {
      reply = (c) =>
        c.url.endsWith('/send')
          ? new Promise<Response>(() => {})
          : c.url.endsWith('/commands')
            ? Response.json({ commands: [{ name: 'model', desc: 'Switch between Claude models', menu: true }] })
            : undefined
      const { ws } = await mount()
      await attach(ws)
      const box = textbox()
      fireEvent.input(box, { target: { value: '/model' } })
      fireEvent.click(screen.getByRole('button', { name: '보내기' }))
      await vi.waitFor(() => expect(sent('/api/terminals/t1/send')).toHaveLength(1))
      await show(SCREENS.model)
      expect(box.value).toBe('/model')
      expect(document.querySelector('.term-slash')).toBeNull()
      expect(fireEvent.keyDown(box, { key: 'ArrowDown' })).toBe(false)
      expect(ws.input()).toEqual([DOWN])
    })

    it('reads out the item the cursor goes to', async () => {
      const { ws } = await mount()
      await attach(ws)
      await show(SCREENS.model)
      await frame()
      fireEvent.keyDown(textbox(), { key: 'ArrowDown' })
      await show(cursorAt(SCREENS.model, 2))
      await frame()
      expect(said()).toBe('2. Sonnet')
    })

    it('moves the cursor with the arrows from a row of the panel', async () => {
      const { ws } = await mount()
      await attach(ws)
      await show(SCREENS.model)
      const row = rowsOf(panel()!)[0]
      row.focus()
      expect(fireEvent.keyDown(row, { key: 'ArrowDown' })).toBe(false)
      expect(ws.input()).toEqual([DOWN])
    })

    // The terminal shows the window, as the panel cannot: the keys still go to it.
    it('moves the cursor of a window the terminal kept', async () => {
      const { ws } = await mount()
      await attach(ws)
      await show(SCREENS['model-cc-short'])
      expect(panel()).toBeNull()
      fireEvent.keyDown(textbox(), { key: 'ArrowDown' })
      expect(ws.input()).toEqual([DOWN])
    })

    it('leaves the keys to the box with text, a modifier or a word being composed', async () => {
      const { ws } = await mount()
      await attach(ws)
      await show(SCREENS.model)
      const box = textbox()
      expect(fireEvent.keyDown(box, { key: 'ArrowDown', shiftKey: true })).toBe(true)
      expect(fireEvent.keyDown(box, { key: 'Enter', isComposing: true })).toBe(true)
      fireEvent.input(box, { target: { value: 'go' } })
      expect(fireEvent.keyDown(box, { key: 'ArrowDown' })).toBe(true)
      expect(fireEvent.keyDown(box, { key: 'Enter' })).toBe(true)
      expect(ws.input()).toEqual([])
    })

    it('leaves the keys to the box with no window', async () => {
      const { ws } = await mount()
      await attach(ws)
      await show(SCREENS.idle)
      expect(fireEvent.keyDown(textbox(), { key: 'ArrowDown' })).toBe(true)
      expect(fireEvent.keyDown(textbox(), { key: 'Enter' })).toBe(true)
      expect(ws.input()).toEqual([])
    })

    // An Enter in an empty box would approve what the program asks: a
    // question is answered by the approval bar's own keys.
    it('leaves the keys to the box while the program is blocked', async () => {
      const { ws } = await mount(blockedTerm())
      await attach(ws)
      await show(SCREENS.permission)
      expect(fireEvent.keyDown(textbox(), { key: 'ArrowDown' })).toBe(true)
      expect(fireEvent.keyDown(textbox(), { key: 'Enter' })).toBe(true)
      expect(ws.input()).toEqual([])
      expect(sent('/api/terminals/t1/keys')).toEqual([])
    })
  })

  // ↑ and ↓ call back what was sent in the folder, from Claude Code's record
  // through the server (claude-input design §5.2, spec §3 #224).
  describe('the box recalls', () => {
    const textbox = () => {
      const box = screen.getByRole('textbox', { name: '터미널에 여러 줄 보내기' }) as HTMLTextAreaElement
      box.focus()
      return box
    }
    const record = (texts: string[], source = 'claude') =>
      (reply = (c) => (c.url.includes('/prompts') ? Response.json({ prompts: texts.map((text, i) => ({ text, at: texts.length - i })), source }) : undefined))

    it('calls back what was sent with ↑, and goes forward with ↓ to what was being written', async () => {
      record(['둘째', '첫째'])
      const { ws } = await mount()
      await attach(ws)
      const box = textbox()
      expect(fireEvent.keyDown(box, { key: 'ArrowUp' })).toBe(false)
      await vi.waitFor(() => expect(box.value).toBe('둘째'))
      expect(box.selectionStart).toBe(2)
      fireEvent.keyDown(box, { key: 'ArrowUp' })
      await vi.waitFor(() => expect(box.value).toBe('첫째'))
      fireEvent.keyDown(box, { key: 'ArrowDown' })
      await vi.waitFor(() => expect(box.value).toBe('둘째'))
      fireEvent.keyDown(box, { key: 'ArrowDown' })
      await vi.waitFor(() => expect(box.value).toBe(''))
      expect(sent('/api/terminals/t1/prompts', 'GET')).toHaveLength(1)
      await frame()
      expect(said()).toBe('둘째')
    })

    it('leaves ↑ to the text, and to a window', async () => {
      record(['둘째'])
      const { ws } = await mount()
      await attach(ws)
      const box = textbox()
      fireEvent.input(box, { target: { value: 'a\nb' } })
      box.setSelectionRange(3, 3)
      expect(fireEvent.keyDown(box, { key: 'ArrowUp' })).toBe(true)
      fireEvent.input(box, { target: { value: '' } })
      await show(SCREENS.model)
      fireEvent.keyDown(box, { key: 'ArrowUp' })
      expect(ws.input()).toEqual(['\x1b[A'])
      expect(sent('/api/terminals/t1/prompts', 'GET')).toEqual([])
    })

    // a long prompt, or one of many lines, is read out by its start
    it('reads out the start of a long recalled prompt', async () => {
      const long = '가'.repeat(70)
      record([`${long}\n둘째 줄`])
      const { ws } = await mount()
      await attach(ws)
      const box = textbox()
      fireEvent.keyDown(box, { key: 'ArrowUp' })
      await vi.waitFor(() => expect(box.value).toBe(`${long}\n둘째 줄`))
      await frame()
      expect(said()).toBe(`${'가'.repeat(60)}…`)
    })

    it('keeps what is typed while the record loads', async () => {
      let done = () => {}
      reply = (c) =>
        c.url.includes('/prompts')
          ? new Promise<Response>((r) => {
              done = () => r(Response.json({ prompts: [{ text: '둘째', at: 2 }], source: 'claude' }))
            })
          : undefined
      const { ws } = await mount()
      await attach(ws)
      const box = textbox()
      fireEvent.keyDown(box, { key: 'ArrowUp' })
      fireEvent.input(box, { target: { value: '새 글' } })
      done()
      await frame(50)
      expect(box.value).toBe('새 글')
    })

    // A long paragraph wraps: ↑ moves the caret up its lines first, and only
    // from the first one, where the browser puts the caret at the start, calls back.
    it('leaves ↑ on a wrapped line to the box', async () => {
      record(['둘째'])
      const { ws } = await mount()
      await attach(ws)
      const box = textbox()
      fireEvent.input(box, { target: { value: '긴 문단이 다음 줄로 넘어갑니다' } })
      box.setSelectionRange(10, 10)
      expect(fireEvent.keyDown(box, { key: 'ArrowUp' })).toBe(true)
      await frame()
      expect(box.value).toBe('긴 문단이 다음 줄로 넘어갑니다')
      // on the first line the browser puts the caret at the start: then it calls back
      fireEvent.keyDown(box, { key: 'ArrowUp' })
      box.setSelectionRange(0, 0)
      await vi.waitFor(() => expect(box.value).toBe('둘째'))
      fireEvent.keyDown(box, { key: 'ArrowDown' })
      await vi.waitFor(() => expect(box.value).toBe('긴 문단이 다음 줄로 넘어갑니다'))
    })

    it('puts a send first though the record does not have it yet', async () => {
      record(['예전 글'])
      const { ws } = await mount()
      await attach(ws)
      const box = textbox()
      fireEvent.input(box, { target: { value: '새로 보낸 글' } })
      fireEvent.click(screen.getByRole('button', { name: '보내기' }))
      await vi.waitFor(() => expect(box.value).toBe(''))
      fireEvent.keyDown(box, { key: 'ArrowUp' })
      await vi.waitFor(() => expect(box.value).toBe('새로 보낸 글'))
      fireEvent.keyDown(box, { key: 'ArrowUp' })
      await vi.waitFor(() => expect(box.value).toBe('예전 글'))
    })

    // what is typed into a shell stays off this device's storage; this visit still calls it back
    it('keeps nothing sent to a terminal that is not Claude Code', async () => {
      const { ws } = await mount(term({ argv: ['/bin/zsh'], status: status('idle', { app: 'zsh' }) }))
      await attach(ws)
      const box = textbox()
      fireEvent.input(box, { target: { value: 'export TOKEN=비밀' } })
      fireEvent.click(screen.getByRole('button', { name: '보내기' }))
      await vi.waitFor(() => expect(box.value).toBe(''))
      expect(Object.keys(localStorage).filter((k) => k.startsWith('mori.sent.'))).toEqual([])
      fireEvent.keyDown(box, { key: 'ArrowUp' })
      await vi.waitFor(() => expect(box.value).toBe('export TOKEN=비밀'))
      expect(sent('/api/terminals/t1/prompts', 'GET')).toEqual([])
    })

    it('falls back to what was sent here', async () => {
      record([], 'none')
      const { ws } = await mount()
      await attach(ws)
      const box = textbox()
      fireEvent.input(box, { target: { value: '여기서 보낸 글' } })
      fireEvent.click(screen.getByRole('button', { name: '보내기' }))
      await vi.waitFor(() => expect(box.value).toBe(''))
      fireEvent.keyDown(box, { key: 'ArrowUp' })
      await vi.waitFor(() => expect(box.value).toBe('여기서 보낸 글'))
    })

    it('an edit leaves the walk', async () => {
      record(['둘째', '첫째'])
      const { ws } = await mount()
      await attach(ws)
      const box = textbox()
      fireEvent.keyDown(box, { key: 'ArrowUp' })
      await vi.waitFor(() => expect(box.value).toBe('둘째'))
      fireEvent.input(box, { target: { value: '둘째!' } })
      // ↓ no longer walks: the edited send is what is being written
      expect(fireEvent.keyDown(box, { key: 'ArrowDown' })).toBe(true)
      fireEvent.input(box, { target: { value: '' } })
      fireEvent.keyDown(box, { key: 'ArrowUp' })
      await vi.waitFor(() => expect(box.value).toBe('둘째'))
    })
  })

  // The input box and what is below it lie under Mori's status band
  // (claude-input design §3, spec §3 #217, #223).
  describe('the cover', () => {
    const IDLE = SCREENS['box-idle']
    const band = () => screen.queryByRole('region', { name: 'Claude Code 상태' })
    const withText = (t: string) => IDLE.replace('\n❯ \n', `\n❯ ${t}\n`)
    const NOTE = '터미널 입력칸에 글이 있습니다 — 보내면 그 뒤에 이어 붙습니다'

    it('covers an empty box with the status band', async () => {
      const { ws } = await mount()
      await attach(ws)
      await show(IDLE)
      const b = band()!
      expect(b.parentElement?.classList.contains('term-stage')).toBe(true)
      // what it shows sits on a sheet at its foot
      expect(b.querySelector('.term-cover-sheet .term-cover-row')).not.toBeNull()
      // the rule over the box: the sample's third line, at the bottom of 24 rows of 17px
      expect(b.style.top).toBe(`${(24 - 9 + 2) * 17}px`)
      expect(within(b).getByText('Opus 5.5').classList.contains('chip')).toBe(true)
      const bars = within(b).getAllByRole('progressbar')
      expect(bars.map((x) => x.getAttribute('aria-valuenow'))).toEqual(['6', '1'])
      expect(within(b).getByText('셸 1')).toBeTruthy()
      // on a PC the mode is a button of the box's row
      const mode = screen.getByRole('button', { name: '모드: 묻지 않음' })
      expect(mode.closest('.term-compose')).not.toBeNull()
    })

    // Claude Code's output reaches the band's sheet: the terminal takes the
    // rows the sheet leaves, and its box and status go below the stage (spec §3 #228)
    it('takes the rows the sheet leaves, keeps them a moment, and gives them back', async () => {
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(80 * 8 + 14)
      layOut({ 'term-stage': 24 * 17, 'term-cover-sheet': 40 })
      const { ws } = await mount()
      await attach(ws)
      const resizes = () => ws.messages().filter((m) => m.type === 'resize')
      const scroller = () => document.querySelector<HTMLElement>('.term-scroll')!
      await show(IDLE)
      // 408px less the 40px sheet holds 21 rows, and the 7 from the rule down go after them
      expect(resizes()).toEqual([{ type: 'resize', cols: 80, rows: 28 }])
      // while the new size is on its way the band stays
      expect(band()).not.toBeNull()
      await act(() => ws.json({ type: 'size', cols: 80, rows: 28 }))
      await show(IDLE)
      expect(band()!.style.top).toBe(`${(28 - 9 + 2) * 17}px`)
      expect(scroller().classList.contains('is-tall')).toBe(true)
      // text in the box takes the cover down, not the rows
      await show(withText('안녕'))
      expect(band()).toBeNull()
      // nor a stage a few pixels taller without the cover: 414px fits 24 rows still, so 28 stay
      layOut({ 'term-stage': 414, 'term-cover-sheet': 40 })
      act(() => {
        window.dispatchEvent(new Event('resize'))
      })
      await frame(200)
      expect(resizes()).toHaveLength(1)
      await show(IDLE)
      expect(band()).not.toBeNull()
      // leaving Claude Code's screen gives them back
      act(() => FakeScreen.last().show('$ ', 'normal'))
      await frame()
      expect(resizes().at(-1)).toEqual({ type: 'resize', cols: 80, rows: 24 })
      await act(() => ws.json({ type: 'size', cols: 80, rows: 24 }))
      expect(scroller().classList.contains('is-tall')).toBe(false)
    })

    // with no mode line the mode is the default one (pickers design §9.5)
    it('reads a box with no mode line as the default mode', async () => {
      const { ws } = await mount()
      await attach(ws)
      await show(IDLE.replace('  ⏵⏵ bypass permissions on · 1 shell\n', ''))
      expect(screen.getByRole('button', { name: '모드: 기본' })).toBeTruthy()
    })

    // rows that do not fit go whole, from the bottom (claude-input design §3.3)
    it('drops whole rows from the bottom of a band too short for them', async () => {
      layOut({ 'term-cover': 50, 'term-cover-row': 24 })
      const { ws } = await mount()
      await attach(ws)
      await show(IDLE)
      const rows = [...band()!.querySelectorAll<HTMLElement>('.term-cover-row')]
      expect(rows).toHaveLength(4)
      expect(rows.map((r) => r.hidden)).toEqual([false, false, true, true])
    })

    // the picker panel and the band share one shot of the screen a frame
    it('reads the screen once a frame for the panel and the band', async () => {
      const { ws } = await mount()
      await attach(ws)
      await show(IDLE)
      const before = FakeScreen.last().builds
      await show(IDLE.replace('ctx 17%', 'ctx 18%'))
      expect(FakeScreen.last().builds - before).toBe(1)
    })

    it('names a bar with no name for a screen reader', async () => {
      const { ws } = await mount()
      await attach(ws)
      await show(IDLE.replace('  current ○○○○○○○○○○   6% ⟳ 4:00오전', '  ○○○○○○○○○○   6%'))
      expect(within(band()!).getAllByRole('progressbar')[0].getAttribute('aria-label')).toBe('상태 막대')
    })

    it('sends shift+tab from the mode button', async () => {
      const { ws } = await mount()
      await attach(ws)
      await show(IDLE)
      fireEvent.click(screen.getByRole('button', { name: '모드: 묻지 않음' }))
      await vi.waitFor(() => expect(ws.input()).toEqual(['\x1b[Z']))
    })

    it('reads out a new mode', async () => {
      const { ws } = await mount()
      await attach(ws)
      await show(IDLE)
      await show(IDLE.replace('⏵⏵ bypass permissions on · 1 shell', '⏸ plan mode on (shift+tab to cycle)'))
      await frame()
      expect(said()).toBe('모드: 계획')
    })

    it('shows the box with text in it, and says so once', async () => {
      const { ws } = await mount()
      await attach(ws)
      await show(withText('abc'))
      expect(band()).toBeNull()
      expect(document.querySelector('.term-boxnote')?.textContent).toBe(NOTE)
      await frame()
      expect(said()).toBe(NOTE)
      live()!.textContent = ''
      await show(withText('abcd'))
      await frame()
      expect(said()).toBe('')
    })

    it('keeps the cover while the box sends', async () => {
      reply = (c) => (c.url.endsWith('/send') ? new Promise<Response>(() => {}) : undefined)
      const { ws } = await mount()
      await attach(ws)
      await show(IDLE)
      const box = screen.getByRole('textbox', { name: '터미널에 여러 줄 보내기' })
      fireEvent.input(box, { target: { value: 'hi' } })
      fireEvent.click(screen.getByRole('button', { name: '보내기' }))
      await vi.waitFor(() => expect(sent('/api/terminals/t1/send')).toHaveLength(1))
      await show(withText('hi'))
      expect(band()).not.toBeNull()
      expect(document.querySelector('.term-boxnote')).toBeNull()
    })

    // the core answers the send before the terminal clears its box, at times
    it('keeps the cover a moment after the send ends', async () => {
      let done = () => {}
      reply = (c) =>
        c.url.endsWith('/send')
          ? new Promise<Response>((r) => {
              done = () => r(Response.json({ started: false }))
            })
          : undefined
      const { ws } = await mount()
      await attach(ws)
      await show(IDLE)
      const box = screen.getByRole('textbox', { name: '터미널에 여러 줄 보내기' })
      fireEvent.input(box, { target: { value: 'hi' } })
      fireEvent.click(screen.getByRole('button', { name: '보내기' }))
      await vi.waitFor(() => expect(sent('/api/terminals/t1/send')).toHaveLength(1))
      await show(withText('hi'))
      done()
      await frame(50)
      expect(band()).not.toBeNull()
      expect(document.querySelector('.term-boxnote')).toBeNull()
      // text that stays past the moment is text: the note shows
      await frame(1000)
      expect(band()).toBeNull()
      expect(document.querySelector('.term-boxnote')?.textContent).toBe(NOTE)
    })

    it('does not cover while only watching', async () => {
      const { ws } = await mount()
      await attach(ws)
      fireEvent.click(more('menuitemcheckbox', '보기 전용'))
      await attach(FakeWebSocket.last())
      await show(IDLE)
      expect(band()).toBeNull()
    })

    it('does not cover a terminal of another size', async () => {
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(840)
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(425)
      const { ws } = await mount()
      await attach(ws, 120, 40)
      await show(IDLE)
      expect(band()).toBeNull()
    })

    it('does not cover while scrolled back, a window, the setting off, or the classic screen', async () => {
      const { ws } = await mount()
      await attach(ws)
      await show(IDLE)
      expect(band()).not.toBeNull()
      act(() => FakeScreen.last().scrollTo(false))
      await frame()
      expect(band()).toBeNull()
      act(() => FakeScreen.last().scrollTo(true))
      await frame()
      expect(band()).not.toBeNull()
      await show(SCREENS.model)
      expect(band()).toBeNull()
      // the PC button keeps the last mode
      expect(screen.getByRole('button', { name: '모드: 묻지 않음' })).toBeTruthy()
      await show(IDLE)
      act(() => setPickOn(false))
      await frame()
      expect(band()).toBeNull()
      act(() => setPickOn(true))
      await show(IDLE)
      expect(band()).not.toBeNull()
      act(() => FakeScreen.last().show(IDLE, 'normal'))
      await frame()
      expect(band()).toBeNull()
    })

    it('shows the box with the switch', async () => {
      const { ws } = await mount()
      await attach(ws)
      await show(IDLE)
      let sw = more('menuitemcheckbox', '터미널 입력칸 보기')
      expect(sw.getAttribute('aria-checked')).toBe('false')
      expect(within(screen.getByRole('group', { name: '보기' })).getByRole('menuitemcheckbox', { name: '터미널 입력칸 보기' })).toBe(sw)
      fireEvent.click(sw)
      await frame()
      expect(band()).toBeNull()
      sw = more('menuitemcheckbox', '터미널 입력칸 보기')
      expect(sw.getAttribute('aria-checked')).toBe('true')
      fireEvent.click(sw)
      await frame()
      expect(band()).not.toBeNull()
    })

    // On a phone the band and the dock below it read as one sheet: the dock
    // gives the band its rounded top while the band shows.
    it('joins the band to the dock on a phone', async () => {
      const { ws } = await mount(undefined, { variant: 'phone', back: '#/folders' })
      await attach(ws)
      const dock = () => document.querySelector('.term-dock')!
      // a window: no band, the dock keeps its rounded top
      await show(SCREENS.model)
      expect(band()).toBeNull()
      expect(dock().classList.contains('is-joined')).toBe(false)
      await show(IDLE)
      expect(band()).not.toBeNull()
      expect(dock().classList.contains('is-joined')).toBe(true)
    })

    it('puts the mode in the band and the switch in the menu on a phone', async () => {
      const { ws } = await mount(undefined, { variant: 'phone', back: '#/folders' })
      await attach(ws)
      await show(IDLE)
      expect(within(band()!).getByRole('button', { name: '모드: 묻지 않음' })).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: '더 보기' }))
      const item = screen.getByRole('menuitemcheckbox', { name: '터미널 입력칸 보기' })
      expect(item.getAttribute('aria-checked')).toBe('false')
      fireEvent.click(item)
      await frame()
      expect(band()).toBeNull()
    })
  })

  // With the cover, the box takes the focus, what is typed, and the paths;
  // on a PC an empty box's Esc and Ctrl+letter go to the terminal
  // (claude-input design §4.1, spec §3 #217).
  describe('with the cover', () => {
    const IDLE = SCREENS['box-idle']
    const textbox = () => screen.getByRole('textbox', { name: '터미널에 여러 줄 보내기' }) as HTMLTextAreaElement
    const stage = () => document.querySelector<HTMLElement>('.term-stage')!

    it('gives the box the focus, and a press on the terminal too', async () => {
      const { ws } = await mount()
      await attach(ws)
      await show(IDLE)
      expect(document.activeElement).toBe(textbox())
      ;(document.activeElement as HTMLElement).blur()
      const xterm = FakeScreen.last().focused
      fireEvent.click(stage())
      expect(document.activeElement).toBe(textbox())
      expect(FakeScreen.last().focused).toBe(xterm)
    })

    it('does nothing on a phone when the terminal is pressed', async () => {
      const { ws } = await mount(undefined, { variant: 'phone', back: '#/folders' })
      await attach(ws)
      await show(IDLE)
      const xterm = FakeScreen.last().focused
      fireEvent.click(stage())
      expect(FakeScreen.last().focused).toBe(xterm)
      expect(document.activeElement).not.toBe(textbox())
      // xterm takes a touch's focus itself: its keyboard stays down, so the terminal keeps its size
      expect(FakeScreen.last().keyboard).toBe(false)
      act(() => setBoxShown(true))
      await frame()
      expect(FakeScreen.last().keyboard).toBe(true)
    })

    it('sends a letter typed on the page to the box, not the terminal', async () => {
      const { ws } = await mount()
      await attach(ws)
      await show(IDLE)
      ;(document.activeElement as HTMLElement).blur()
      fireEvent.keyDown(document.body, { key: 'a' })
      expect(document.activeElement).toBe(textbox())
      fireEvent.keyDown(document.body, { key: 'Enter' })
      expect(ws.input()).toEqual([])
    })

    it("sends an empty box's Esc and Ctrl+letter to the terminal", async () => {
      const { ws } = await mount()
      await attach(ws)
      await show(IDLE)
      const box = textbox()
      box.focus()
      expect(fireEvent.keyDown(box, { key: 'Escape' })).toBe(false)
      expect(fireEvent.keyDown(box, { key: 'o', ctrlKey: true })).toBe(false)
      expect(ws.input()).toEqual(['\x1b', '\x0f'])
      // Ctrl+V pastes; a word being composed, and text in the box, keep their keys
      expect(fireEvent.keyDown(box, { key: 'v', ctrlKey: true })).toBe(true)
      expect(fireEvent.keyDown(box, { key: 'Escape', isComposing: true })).toBe(true)
      fireEvent.input(box, { target: { value: 'go' } })
      expect(fireEvent.keyDown(box, { key: 'Escape' })).toBe(true)
      expect(fireEvent.keyDown(box, { key: 'o', ctrlKey: true })).toBe(true)
      expect(ws.input()).toEqual(['\x1b', '\x0f'])
    })

    // Shift+Tab would land in the question: in an edit permission it allows every edit
    it('turns the mode button off while a window or a question shows', async () => {
      const { ws } = await mount()
      await attach(ws)
      await show(IDLE)
      const mode = () => screen.getByRole('button', { name: '모드: 묻지 않음' }) as HTMLButtonElement
      expect(mode().disabled).toBe(false)
      await show(SCREENS.model)
      expect(mode().disabled).toBe(true)
      fireEvent.click(mode())
      expect(ws.input()).toEqual([])
      await show(IDLE)
      expect(mode().disabled).toBe(false)
      act(() => load([blockedTerm()]))
      await frame()
      expect(mode().disabled).toBe(true)
    })

    // On Windows and Linux Ctrl+C copies the terminal's selection, as from xterm itself
    it('copies the terminal selection with Ctrl+C rather than interrupt', async () => {
      const writeText = vi.fn(async () => {})
      vi.stubGlobal('isSecureContext', true)
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true, writable: true })
      try {
        const { ws } = await mount()
        await attach(ws)
        await show(IDLE)
        FakeScreen.last().selected = '고른 글'
        const box = textbox()
        box.focus()
        expect(fireEvent.keyDown(box, { key: 'c', ctrlKey: true })).toBe(false)
        expect(ws.input()).toEqual([])
        await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('고른 글'))
        expect(FakeScreen.last().selected).toBe('')
        // nothing chosen: Ctrl+C interrupts
        fireEvent.keyDown(box, { key: 'c', ctrlKey: true })
        expect(ws.input()).toEqual(['\x03'])
      } finally {
        delete (navigator as { clipboard?: unknown }).clipboard
      }
    })

    it('keeps the keys in the box without the cover', async () => {
      const { ws } = await mount()
      await attach(ws)
      await show(SCREENS.idle.replace('❯', '❯ x'))
      const box = textbox()
      box.focus()
      expect(fireEvent.keyDown(box, { key: 'Escape' })).toBe(true)
      expect(ws.input()).toEqual([])
    })

    // xterm may hold the focus (a drag to select): text pasted there goes to the box
    it('puts text pasted on the terminal into the box', async () => {
      const { ws } = await mount()
      await attach(ws)
      await show(IDLE)
      const getData = (t: string) => (t === 'text/plain' ? '붙인 글' : '')
      expect(fireEvent.paste(stage(), { clipboardData: { files: [], types: ['text/plain'], getData } })).toBe(false)
      expect(textbox().value).toBe('붙인 글')
      expect(document.activeElement).toBe(textbox())
      expect(ws.input()).toEqual([])
    })

    it('puts the path of a file pasted on the terminal into the box', async () => {
      reply = (c) => (c.url.endsWith('/files') ? Response.json({ path: '/Users/me/dev/Mori/.mori/up/a.png', bytes: 3 }) : undefined)
      const { ws } = await mount()
      await attach(ws)
      await show(IDLE)
      const files = [new File(['png'], 'a.png', { type: 'image/png' })]
      fireEvent.paste(stage(), { clipboardData: { files, types: ['Files'], getData: () => '' } })
      await vi.waitFor(() => expect(textbox().value).toBe('/Users/me/dev/Mori/.mori/up/a.png '))
      expect(ws.input()).toEqual([])
    })
  })

  // The grey hint of the terminal's empty box shows in Mori's box, and Tab
  // takes it (claude-input design §6, spec §3 #225).
  describe('the hint', () => {
    const IDLE = SCREENS['box-idle']
    const HINT = 'describe a task for a new session'
    const textbox = () => screen.getByRole('textbox', { name: '터미널에 여러 줄 보내기' }) as HTMLTextAreaElement
    // the sample's ❯ line (its fourth) with the hint in grey after "❯ "
    const hinted = async () => {
      act(() => FakeScreen.last().show(IDLE.replace('\n❯ \n', `\n❯ ${HINT}\n`), 'alternate', (y, x) => (y === 3 && x >= 2 ? 'rgb:153,153,153' : '')))
      await frame()
    }

    it('shows the hint in the box, and Tab takes it', async () => {
      const { ws } = await mount()
      await attach(ws)
      await show(IDLE)
      const plain = textbox().placeholder
      expect(plain).toMatch(/^여러 줄로 보내기 · /)
      await hinted()
      const box = textbox()
      expect(box.placeholder).toBe(`${HINT} · Tab`)
      // still covered: a hint is no text
      expect(screen.queryByRole('region', { name: 'Claude Code 상태' })).not.toBeNull()
      box.focus()
      expect(fireEvent.keyDown(box, { key: 'Tab' })).toBe(false)
      expect(box.value).toBe(HINT)
      expect(box.selectionStart).toBe(HINT.length)
      // with text Tab is the box's own, and the hint goes from the placeholder
      expect(fireEvent.keyDown(box, { key: 'Tab' })).toBe(true)
      await show(IDLE)
      expect(textbox().placeholder).toBe(plain)
    })

    // a phone has no Tab for the box: the hint shows alone, and the quick key Tab takes it
    it('takes the hint with the quick key Tab on a phone', async () => {
      const { ws } = await mount(undefined, { variant: 'phone', back: '#/folders' })
      await attach(ws)
      await hinted()
      const box = textbox()
      expect(box.placeholder).toBe(HINT)
      fireEvent.click(within(screen.getByRole('region', { name: '빠른 키' })).getByRole('button', { name: 'Tab' }))
      expect(box.value).toBe(HINT)
      expect(ws.input()).toEqual([])
      // with text in the box the quick key Tab goes to the terminal, as ever
      fireEvent.click(within(screen.getByRole('region', { name: '빠른 키' })).getByRole('button', { name: 'Tab' }))
      expect(ws.input()).toEqual(['\t'])
    })

    it('shows the hint while the terminal shows its own box', async () => {
      const { ws } = await mount()
      await attach(ws)
      act(() => setBoxShown(true))
      await hinted()
      expect(textbox().placeholder).toBe(`${HINT} · Tab`)
    })
  })
})
