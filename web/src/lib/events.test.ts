import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { FakeWebSocket } from '../../test/fakeWs'
import { term } from '../../test/fixtures'
import { Backoff } from './backoff'
import { EventStream, type SocketCtor } from './events'
import { apply, conn, resetStore, terminals } from './store'

const URL = 'ws://macmini.example.ts.net/ws/events'

let unauthorized: Mock<() => void>
let dropped: Mock<(code: number) => void>
let stream: EventStream

function snapshot(...addrs: string[]) {
  FakeWebSocket.last().json({ type: 'snapshot', core: { connected: true }, folders: [], terminals: addrs.map((a) => term({ address: a })) })
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeWebSocket.reset()
  resetStore()
  unauthorized = vi.fn<() => void>()
  dropped = vi.fn<(code: number) => void>()
  stream = new EventStream({
    url: URL,
    socket: FakeWebSocket as unknown as SocketCtor,
    apply,
    setConn: (c) => { conn.value = c },
    onUnauthorized: unauthorized,
    onDrop: dropped,
    backoff: new Backoff(500, 10_000, 0.2, () => 0.5),
  })
  stream.start()
})

afterEach(() => {
  stream.stop()
  vi.useRealTimers()
})

describe('EventStream', () => {
  it('is open once the snapshot came', () => {
    expect(FakeWebSocket.all).toHaveLength(1)
    expect(FakeWebSocket.last().url).toBe(URL)
    FakeWebSocket.last().open()
    expect(conn.value).toBe('connecting')
    snapshot('t1')
    expect(conn.value).toBe('open')
    expect([...terminals.value.keys()]).toEqual(['t1'])
  })

  it('comes back at once after 1013 and the new snapshot replaces the old state', () => {
    FakeWebSocket.last().open()
    snapshot('t1', 't2')
    FakeWebSocket.last().json({ type: 'terminal', terminal: term({ address: 't3' }) })
    FakeWebSocket.last().drop(1013, '이벤트가 밀렸습니다. 다시 연결하세요')
    vi.advanceTimersByTime(0)
    expect(FakeWebSocket.all).toHaveLength(2)
    FakeWebSocket.last().open()
    snapshot('t2')
    expect([...terminals.value.keys()]).toEqual(['t2'])
    expect(conn.value).toBe('open')
  })

  it('says the server restarts after 1001 and waits before trying again', () => {
    FakeWebSocket.last().open()
    snapshot()
    FakeWebSocket.last().drop(1001)
    expect(conn.value).toBe('restarting')
    vi.advanceTimersByTime(499)
    expect(FakeWebSocket.all).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(FakeWebSocket.all).toHaveLength(2)
    FakeWebSocket.last().drop(1006) // still down: keep saying it restarts
    expect(conn.value).toBe('restarting')
    vi.advanceTimersByTime(1000)
    FakeWebSocket.last().open()
    snapshot()
    expect(conn.value).toBe('open')
  })

  it('shows the banner only after two seconds down', () => {
    FakeWebSocket.last().open()
    snapshot()
    FakeWebSocket.last().drop(1006)
    expect(conn.value).toBe('connecting')
    vi.advanceTimersByTime(1999)
    expect(conn.value).toBe('connecting')
    vi.advanceTimersByTime(1)
    expect(conn.value).toBe('down')
  })

  it('backs off 0.5, 1, 2 s and starts over after a snapshot', () => {
    const waits: number[] = []
    for (let i = 0; i < 3; i++) {
      const n = FakeWebSocket.all.length
      FakeWebSocket.last().drop(1006)
      let t = 0
      while (FakeWebSocket.all.length === n) { vi.advanceTimersByTime(10); t += 10 }
      waits.push(t)
    }
    expect(waits).toEqual([500, 1000, 2000])
    FakeWebSocket.last().open()
    snapshot()
    FakeWebSocket.last().drop(1006)
    vi.advanceTimersByTime(500)
    expect(FakeWebSocket.all).toHaveLength(5)
  })

  it('stops and goes to pairing on 4401', () => {
    FakeWebSocket.last().open()
    FakeWebSocket.last().drop(4401, '이 기기는 페어링되지 않았습니다')
    expect(unauthorized).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60_000)
    expect(FakeWebSocket.all).toHaveLength(1)
  })

  it('ignores pings and junk', () => {
    const spy = vi.fn()
    stream.stop()
    FakeWebSocket.reset()
    stream = new EventStream({ url: URL, socket: FakeWebSocket as unknown as SocketCtor, apply: spy, setConn: () => {}, onUnauthorized: () => {} })
    stream.start()
    FakeWebSocket.last().open()
    FakeWebSocket.last().json({ type: 'ping' })
    FakeWebSocket.last().receive('{not json')
    FakeWebSocket.last().receive(new Uint8Array([1, 2]))
    expect(spy).not.toHaveBeenCalled()
  })

  it('treats a silent socket as dead', () => {
    FakeWebSocket.last().open()
    snapshot()
    vi.advanceTimersByTime(30_000)
    FakeWebSocket.last().json({ type: 'ping' })
    vi.advanceTimersByTime(74_999)
    expect(FakeWebSocket.all).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(FakeWebSocket.all[0].closedWith).not.toBeNull()
    vi.advanceTimersByTime(500)
    expect(FakeWebSocket.all).toHaveLength(2)
  })

  it('tries at once when nudged while waiting', () => {
    FakeWebSocket.last().drop(1006)
    expect(FakeWebSocket.all).toHaveLength(1)
    stream.nudge()
    expect(FakeWebSocket.all).toHaveLength(2)
    stream.nudge() // a socket is already on its way
    expect(FakeWebSocket.all).toHaveLength(2)
  })

  it('asks an open socket whether it is alive when nudged, and keeps one that answers', () => {
    const ws = FakeWebSocket.last()
    ws.open()
    snapshot('t1')
    stream.nudge()
    stream.nudge() // one ping out at a time
    expect(ws.messages()).toEqual([{ type: 'ping' }])
    ws.json({ type: 'pong' })
    vi.advanceTimersByTime(10_000)
    expect(FakeWebSocket.all).toHaveLength(1)
    expect(ws.closedWith).toBeNull()
    expect(conn.value).toBe('open')
    expect([...terminals.value.keys()]).toEqual(['t1'])
  })

  it('makes a new socket at once when the nudged one does not answer', () => {
    const ws = FakeWebSocket.last()
    ws.open()
    snapshot('t1')
    stream.nudge()
    vi.advanceTimersByTime(3_999)
    expect(FakeWebSocket.all).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(ws.closedWith).not.toBeNull()
    expect(dropped.mock.calls).toEqual([[1006]])
    expect(FakeWebSocket.all).toHaveLength(2)
    FakeWebSocket.last().open()
    snapshot('t2')
    expect(conn.value).toBe('open')
    expect([...terminals.value.keys()]).toEqual(['t2'])
  })

  it('stays down after stop', () => {
    const ws = FakeWebSocket.last()
    ws.open()
    stream.stop()
    expect(ws.closedWith).not.toBeNull()
    vi.advanceTimersByTime(60_000)
    expect(FakeWebSocket.all).toHaveLength(1)
  })

  it('tells the close code of every drop it retries', async () => {
    FakeWebSocket.last().drop(4502)
    await vi.advanceTimersByTimeAsync(500)
    FakeWebSocket.last().drop(4404)
    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeWebSocket.all).toHaveLength(3)
    FakeWebSocket.last().drop(4401)
    expect(dropped.mock.calls).toEqual([[4502], [4404]])
  })

  it("stays stopped when the drop's handler stops it", async () => {
    dropped.mockImplementation(() => stream.stop())
    FakeWebSocket.last().drop(1006)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(FakeWebSocket.all).toHaveLength(1)
  })
})
