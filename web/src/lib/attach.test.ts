import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeWebSocket } from '../../test/fakeWs'
import { term } from '../../test/fixtures'
import { AttachSession, type Attached, type AttachOptions, type AttachState, type Closed } from './attach'
import { Backoff } from './backoff'
import type { SocketCtor } from './events'

const BASE = 'ws://macmini.example.ts.net/ws/attach'
const FACTS = { fg: '#ecebe7', bg: '#1f1e1c', cursor: '#ecebe7', cell: [8, 17] as [number, number] }

let sessions: AttachSession[] = []

function session(o: Partial<AttachOptions> = {}) {
  const s = new AttachSession({
    addr: 't1',
    cols: 100,
    rows: 30,
    url: BASE,
    socket: FakeWebSocket as unknown as SocketCtor,
    backoff: new Backoff(500, 10_000, 0.2, () => 0.5),
    ...o,
  })
  const states: AttachState[] = []
  s.on('state', (st) => states.push(st))
  sessions.push(s)
  s.start()
  return { s, states }
}

/** Opens the newest socket and says it is attached at cols×rows. */
function attached(cols = 100, rows = 30) {
  const ws = FakeWebSocket.last()
  ws.open()
  ws.json({ type: 'attached', terminal: term(), cols, rows })
  return ws
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeWebSocket.reset()
  sessions = []
})

afterEach(() => {
  for (const s of sessions) s.stop()
  vi.useRealTimers()
})

describe('AttachSession', () => {
  it('asks for the terminal at the size this screen fits', () => {
    session({ addr: 'machine/t7', history: 2000 })
    const ws = FakeWebSocket.last()
    expect(ws.url.startsWith(BASE + '?t=machine%2Ft7&')).toBe(true)
    const q = ws.query()
    expect(q.get('t')).toBe('machine/t7')
    expect([q.get('cols'), q.get('rows'), q.get('history')]).toEqual(['100', '30', '2000'])
    expect(q.has('observe')).toBe(false)
    expect(q.has('resumed')).toBe(false)
    expect(ws.binaryType).toBe('arraybuffer')
  })

  it('is open once attached and passes the output on', () => {
    const { s, states } = session()
    const got: Attached[] = []
    const out: string[] = []
    s.on('attached', (a) => got.push(a))
    s.on('data', (d) => out.push(new TextDecoder().decode(d)))
    const ws = attached(120, 40)
    expect(states).toEqual(['open'])
    expect(got).toEqual([{ terminal: term(), cols: 120, rows: 40, resumed: false }])
    expect([s.cols, s.rows]).toEqual([120, 40])
    ws.receive(new TextEncoder().encode('안녕 hello'))
    expect(out).toEqual(['안녕 hello'])
  })

  it('types only while attached', () => {
    const { s } = session()
    expect(s.send('x')).toBe(false)
    const ws = attached()
    expect(s.send('ls\r')).toBe(true)
    expect(s.send(new Uint8Array([0x1b]))).toBe(true)
    expect(ws.input()).toEqual(['ls\r', '\x1b'])
  })

  it('resizes when the fit changes, not to fight another screen', () => {
    const { s } = session()
    const ws = attached(100, 30)
    s.resize(100, 30)
    s.resize(90, 30)
    s.resize(90, 30)
    expect(ws.messages()).toEqual([{ type: 'resize', cols: 90, rows: 30 }])
    ws.json({ type: 'size', cols: 120, rows: 40 }) // another screen made it bigger
    expect([s.cols, s.rows]).toEqual([120, 40])
    s.resize(90, 30)
    expect(ws.messages()).toHaveLength(1)
    s.resize(90, 30, true) // 이 화면에 맞추기
    expect(ws.messages()).toEqual([
      { type: 'resize', cols: 90, rows: 30 },
      { type: 'resize', cols: 90, rows: 30 },
    ])
  })

  it('sends a fit found while connecting once attached, not one it asked for', () => {
    const { s } = session({ cols: undefined, rows: undefined })
    s.resize(90, 28)
    const ws = attached(80, 24)
    expect(ws.messages()).toEqual([{ type: 'resize', cols: 90, rows: 28 }])
    ws.drop()
    vi.advanceTimersByTime(500)
    // asked for 90×28 this time; a bigger screen elsewhere keeps its size
    expect(FakeWebSocket.last().query().get('cols')).toBe('90')
    expect(attached(120, 40).messages()).toEqual([])
  })

  it('says the size another screen set', () => {
    const { s } = session()
    const sizes: unknown[] = []
    s.on('size', (z) => sizes.push(z))
    attached().json({ type: 'size', cols: 132, rows: 43 })
    expect(sizes).toEqual([{ cols: 132, rows: 43 }])
  })

  it('tells the focus and the display once per change, and again after attaching anew', () => {
    const { s } = session()
    s.focus(true) // before attaching: kept for then
    s.display(FACTS)
    let ws = attached()
    expect(ws.messages()).toEqual([
      { type: 'display', ...FACTS },
      { type: 'focus', focused: true },
    ])
    s.focus(true)
    s.display({ ...FACTS })
    expect(ws.messages()).toHaveLength(2)
    s.display({ ...FACTS, bg: '#121110' })
    s.focus(false)
    expect(ws.messages().slice(2)).toEqual([
      { type: 'display', ...FACTS, bg: '#121110' },
      { type: 'focus', focused: false },
    ])
    ws.drop(1006)
    vi.advanceTimersByTime(500)
    ws = attached()
    expect(ws.messages()).toEqual([{ type: 'display', ...FACTS, bg: '#121110' }]) // not focused: nothing to say
  })

  it('only watches when observing', () => {
    const { s } = session({ observe: true })
    const q = FakeWebSocket.last().query()
    expect(q.get('observe')).toBe('1')
    expect(q.has('cols') || q.has('rows')).toBe(false)
    s.display(FACTS)
    const ws = attached()
    expect(s.send('x')).toBe(false)
    s.resize(50, 20, true)
    s.focus(true) // still counts: someone is looking
    expect(ws.input()).toEqual([])
    expect(ws.messages()).toEqual([{ type: 'focus', focused: true }])
    expect(s.observing).toBe(true)
  })

  it('attaches again with resumed=1 and the latest size after a drop', () => {
    const { s, states } = session()
    const got: boolean[] = []
    s.on('attached', (a) => got.push(a.resumed))
    attached().drop(1006)
    expect(s.state).toBe('reconnecting')
    s.resize(80, 20) // the phone turned while away
    vi.advanceTimersByTime(499)
    expect(FakeWebSocket.all).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(FakeWebSocket.all).toHaveLength(2)
    const q = FakeWebSocket.last().query()
    expect([q.get('resumed'), q.get('cols'), q.get('rows')]).toEqual(['1', '80', '20'])
    FakeWebSocket.last().drop(1006) // still down: wait longer
    vi.advanceTimersByTime(999)
    expect(FakeWebSocket.all).toHaveLength(2)
    vi.advanceTimersByTime(1)
    attached(80, 20)
    expect(states).toEqual(['open', 'reconnecting', 'open'])
    expect(got).toEqual([false, true])
    FakeWebSocket.last().drop(1006) // the wait starts over once attached
    vi.advanceTimersByTime(500)
    expect(FakeWebSocket.all).toHaveLength(4)
  })

  it('is not resumed before it ever attached', () => {
    const { s } = session()
    FakeWebSocket.last().drop(1006)
    expect(s.state).toBe('reconnecting')
    vi.advanceTimersByTime(500)
    expect(FakeWebSocket.last().query().has('resumed')).toBe(false)
  })

  it('waits for the core after 4503 and goes back as soon as it is up', () => {
    const { s } = session()
    attached().drop(4503, '코어에 연결되어 있지 않습니다')
    expect(s.state).toBe('waiting-core')
    s.notifyCore(false)
    expect(FakeWebSocket.all).toHaveLength(1)
    s.notifyCore(true)
    expect(FakeWebSocket.all).toHaveLength(2)
    expect(FakeWebSocket.last().query().get('resumed')).toBe('1')
    expect(s.state).toBe('waiting-core') // until attached
    s.notifyCore(true) // a socket is on its way
    expect(FakeWebSocket.all).toHaveLength(2)
    attached()
    expect(s.state).toBe('open')
  })

  it('still tries now and then while the core stays down', () => {
    const { s } = session()
    attached().drop(4503)
    vi.advanceTimersByTime(500)
    expect(FakeWebSocket.all).toHaveLength(2)
    FakeWebSocket.last().drop(4503)
    vi.advanceTimersByTime(1000)
    expect(FakeWebSocket.all).toHaveLength(3)
    expect(s.state).toBe('waiting-core')
  })

  it('waits for the terminal to come back after 4409', () => {
    const { s } = session()
    attached().drop(4409, '터미널을 되살리는 중입니다')
    expect(s.state).toBe('recovering')
    s.notifyTerminal(term({ pid: null }))
    s.notifyTerminal(term({ state: 'finished' }))
    expect(FakeWebSocket.all).toHaveLength(1)
    s.notifyTerminal(term({ pid: 4242 }))
    expect(FakeWebSocket.all).toHaveLength(2)
  })

  it('ends for good after closed and 1000', () => {
    const { s } = session()
    const ended: Closed[] = []
    s.on('closed', (c) => ended.push(c))
    const ws = attached()
    ws.json({ type: 'closed', reason: 'exited', exit_code: 0, signal: null })
    ws.drop(1000, 'exited')
    expect(s.state).toBe('closed')
    expect(ended).toEqual([{ reason: 'exited', exit_code: 0, signal: null }])
    expect(s.ended).toEqual(ended[0])
    vi.advanceTimersByTime(60_000)
    expect(FakeWebSocket.all).toHaveLength(1)
  })

  it('says a terminal that is not there is gone', () => {
    const { s } = session()
    FakeWebSocket.last().drop(4404, '터미널이 없습니다')
    expect(s.state).toBe('gone')
    expect(s.reason).toBe('터미널이 없습니다')
    vi.advanceTimersByTime(60_000)
    expect(FakeWebSocket.all).toHaveLength(1)
  })

  it('goes to pairing on 4401 and gives up on 4400', () => {
    const unauthorized = vi.fn()
    const a = session({ onUnauthorized: unauthorized })
    FakeWebSocket.last().drop(4401, '이 기기는 페어링되지 않았습니다')
    expect(a.s.state).toBe('error')
    expect(unauthorized).toHaveBeenCalledTimes(1)
    const b = session()
    FakeWebSocket.last().drop(4400, '크기가 잘못되었습니다')
    expect(b.s.state).toBe('error')
    expect(b.s.reason).toBe('크기가 잘못되었습니다')
    vi.advanceTimersByTime(60_000)
    expect(FakeWebSocket.all).toHaveLength(2)
  })

  it('tries at once when nudged while waiting to reconnect', () => {
    const { s } = session()
    s.nudge() // attaching: nothing to hurry
    expect(FakeWebSocket.all).toHaveLength(1)
    attached().drop(1006)
    s.nudge()
    expect(FakeWebSocket.all).toHaveLength(2)
    s.nudge()
    expect(FakeWebSocket.all).toHaveLength(2)
  })

  it('stops for good', () => {
    const { s } = session()
    const ws = attached()
    s.stop()
    expect(ws.closedWith).not.toBeNull()
    expect(s.send('x')).toBe(false)
    s.nudge()
    vi.advanceTimersByTime(60_000)
    expect(FakeWebSocket.all).toHaveLength(1)
  })

  it('ignores what it does not know', () => {
    const { s, states } = session()
    const ws = FakeWebSocket.last()
    ws.open()
    ws.receive('{not json')
    ws.json({ type: 'what' })
    ws.json(null)
    expect(states).toEqual([])
    expect(s.state).toBe('connecting')
  })
})
