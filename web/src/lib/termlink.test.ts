import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeScreen } from '../../test/fakeScreen'
import { FakeWebSocket } from '../../test/fakeWs'
import { term } from '../../test/fixtures'
import type { SocketCtor } from './events'
import { core, resetStore, terminals } from './store'
import { TermLink, type TermLinkOptions } from './termlink'
import { theme } from './theme'

const URL = 'ws://macmini.example.ts.net/ws/attach'
const enc = new TextEncoder()
let links: TermLink[] = []

function link(o: Partial<TermLinkOptions> = {}) {
  const screen = new FakeScreen()
  const l = new TermLink({
    addr: 't1',
    screen,
    fit: { cols: 100, rows: 30 },
    url: URL,
    socket: FakeWebSocket as unknown as SocketCtor,
    ...o,
  })
  links.push(l)
  return { l, screen, ws: FakeWebSocket.last() }
}

function attach(ws: FakeWebSocket, cols = 100, rows = 30) {
  ws.open()
  ws.json({ type: 'attached', terminal: term(), cols, rows })
  return ws
}

const ofType = (ws: FakeWebSocket, type: string) => ws.messages().filter((m) => m.type === type)

beforeEach(() => {
  vi.useFakeTimers()
  FakeWebSocket.reset()
  links = []
  theme.value = 'dark'
  core.value = { connected: true }
})

afterEach(() => {
  for (const l of links) l.dispose()
  resetStore()
  theme.value = 'system'
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('TermLink', () => {
  it('attaches at the size that fits and paints what comes', () => {
    const { l, screen, ws } = link()
    expect([ws.query().get('cols'), ws.query().get('rows')]).toEqual(['100', '30'])
    screen.text = 'old screen'
    attach(ws, 100, 30)
    expect(screen.resets).toBe(1)
    expect([screen.cols, screen.rows]).toEqual([100, 30])
    ws.receive(enc.encode('$ ls\r\n'))
    expect(screen.text).toBe('$ ls\r\n')
    expect(l.state.value).toBe('open')
    expect(l.size.value).toEqual({ cols: 100, rows: 30 })
  })

  it('attaches at the terminal\'s own size while the fit is unknown, so nothing is resized', () => {
    const { l, ws } = link({ fit: null, start: { cols: 120, rows: 40 } })
    expect([ws.query().get('cols'), ws.query().get('rows')]).toEqual(['120', '40'])
    attach(ws, 120, 40)
    expect(ofType(ws, 'resize')).toEqual([])
    expect(l.fit.value).toBeNull()
    l.setFit({ cols: 90, rows: 30 })
    expect(ofType(ws, 'resize')).toEqual([{ type: 'resize', cols: 90, rows: 30 }])
  })

  it('types what a person types and the quick keys as the program reads them', () => {
    const { l, screen, ws } = link()
    attach(ws)
    screen.type('ls\r')
    expect(l.key('up')).toBe(true)
    screen.app = true
    l.key('up')
    expect(l.send('y')).toBe(true)
    expect(ws.input()).toEqual(['ls\r', '\x1b[A', '\x1bOA', 'y'])
    screen.typeBinary('\x80')
    expect([...(ws.sent.at(-1) as Uint8Array)]).toEqual([0x80])
  })

  it('follows the size another screen sets and asks for its own on a change or a fit', () => {
    const { l, screen, ws } = link()
    attach(ws)
    ws.json({ type: 'size', cols: 120, rows: 40 })
    expect([screen.cols, screen.rows]).toEqual([120, 40])
    expect(l.size.value).toEqual({ cols: 120, rows: 40 })
    l.setFit({ cols: 100, rows: 30 })
    expect(ofType(ws, 'resize')).toEqual([])
    l.setFit({ cols: 90, rows: 30 })
    l.fitNow()
    expect(ofType(ws, 'resize')).toEqual([
      { type: 'resize', cols: 90, rows: 30 },
      { type: 'resize', cols: 90, rows: 30 },
    ])
    expect(l.fit.value).toEqual({ cols: 90, rows: 30 })
  })

  it('tells the colours and the cell size, and again for another theme', () => {
    const { screen, ws } = link()
    expect(screen.theme?.background).toBe('#121110')
    attach(ws)
    expect(ofType(ws, 'display')).toEqual([{ type: 'display', fg: '#ECEAE5', bg: '#121110', cursor: '#ECEAE5', cell: [8, 17] }])
    theme.value = 'light'
    expect(screen.theme?.background).toBe('#1F1E1C')
    expect(ofType(ws, 'display').at(-1)).toMatchObject({ bg: '#1F1E1C' })
  })

  it('says whether a person looks at it', () => {
    let focused = true
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const { ws } = link()
    attach(ws)
    focused = false
    window.dispatchEvent(new Event('blur'))
    expect(ofType(ws, 'focus')).toEqual([
      { type: 'focus', focused: true },
      { type: 'focus', focused: false },
    ])
  })

  it('paints a terminal that had ended from its last text', async () => {
    const fetch = vi.fn(async () => Response.json({ text: 'done\nbye', complete: true, how: 'screen' }))
    vi.stubGlobal('fetch', fetch)
    terminals.value = new Map([['t1', term({ state: 'finished', cols: 132, rows: 40 })]])
    const { l, screen, ws } = link()
    ws.open()
    ws.json({ type: 'closed', reason: 'exited', exit_code: 0, signal: null })
    ws.drop(1000)
    expect(l.state.value).toBe('closed')
    expect(l.ended.value).toEqual({ reason: 'exited', exit_code: 0, signal: null })
    await vi.waitFor(() => expect(screen.text).toBe('done\r\nbye\x1b[?25l'))
    expect(fetch.mock.calls[0]).toEqual(['/api/terminals/t1/text?lines=1000', expect.anything()])
    expect([screen.cols, screen.rows]).toEqual([132, 40])
    expect(screen.input).toBe(false)
  })

  it('keeps the screen of a program that ends while attached', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const { screen, ws } = link()
    attach(ws).receive(enc.encode('bye'))
    ws.json({ type: 'closed', reason: 'exited', exit_code: 0, signal: null })
    ws.drop(1000)
    await vi.waitFor(() => expect(screen.text).toBe('bye\x1b[?25l'))
    expect(fetch).not.toHaveBeenCalled()
  })

  it('only watches in observe mode, and can switch back', () => {
    const { l, screen, ws } = link()
    attach(ws)
    l.setObserve(true)
    expect(ws.closedWith).not.toBeNull()
    const obs = FakeWebSocket.last()
    expect(obs.query().get('observe')).toBe('1')
    expect(obs.query().has('cols')).toBe(false)
    attach(obs, 120, 40)
    expect(screen.input).toBe(false)
    expect(l.observing.value).toBe(true)
    expect(l.send('x')).toBe(false)
    l.setObserve(false)
    const back = FakeWebSocket.last()
    expect(back.query().get('cols')).toBe('100')
    attach(back)
    expect(screen.input).toBe(true)
  })

  it('goes back as soon as the core or the terminal is back', () => {
    const { l, ws } = link()
    attach(ws).drop(4503)
    expect(l.state.value).toBe('waiting-core')
    core.value = { connected: false }
    expect(FakeWebSocket.all).toHaveLength(1)
    core.value = { connected: true }
    expect(FakeWebSocket.all).toHaveLength(2)
    attach(FakeWebSocket.last()).drop(4409, '복구 중')
    expect(l.state.value).toBe('recovering')
    expect(l.reason.value).toBe('복구 중')
    terminals.value = new Map([['t1', term({ pid: 7 })]])
    expect(FakeWebSocket.all).toHaveLength(3)
  })

  it('lets go of everything when disposed', () => {
    const { l, screen, ws } = link()
    attach(ws)
    l.dispose()
    expect(ws.closedWith).not.toBeNull()
    screen.type('x')
    core.value = { connected: false }
    expect(ws.input()).toEqual([])
    expect(FakeWebSocket.all).toHaveLength(1)
  })
})
