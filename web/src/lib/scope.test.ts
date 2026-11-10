import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeWebSocket } from '../../test/fakeWs'
import { linkedHost, status, term } from '../../test/fixtures'
import { onUnauthorized } from './api'
import { Backoff } from './backoff'
import type { SocketCtor } from './events'
import { scopeOf, scopes, startHosts, totalNeeds } from './scope'
import { hosts, hostsReady, hubStore } from './store'
import type { Host, TerminalView } from './types'

type Reply = () => Response
let routes: Record<string, Reply>
let stop: () => void
const HELLO = { app: 'mori', version: '0.1.0', host: 'macmini', paired: true }
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const DESK = { host: { name: 'desk', version: '0.11.0' }, core: { connected: true }, folders: [], terminals: [], presets: [], hosts: [] }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  FakeWebSocket.reset()
  routes = { 'GET /api/hello': () => json(200, HELLO) }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const r = routes[`${init.method} ${url}`]
    return r ? r() : json(404, { error: { kind: 'not_found', message: '없습니다' } })
  }))
  stop = startHosts({ socket: FakeWebSocket as unknown as SocketCtor, backoff: () => new Backoff(500, 10_000, 0.2, () => 0.5) })
})

afterEach(() => {
  stop()
  hosts.value = []
  hostsReady.value = false
  hubStore.reset()
  onUnauthorized(null)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function linked(over: Partial<Host> = {}) {
  hosts.value = [linkedHost(over)]
  return scopeOf('h_desk0001')!
}
const ws = () => FakeWebSocket.last()
const snap = (...ts: TerminalView[]) => ws().json({ type: 'snapshot', core: { connected: true }, folders: [], terminals: ts })

describe('startHosts', () => {
  it("keeps each host's state apart", () => {
    const s = linked()
    expect(ws().url).toBe(`ws://${location.host}/h/h_desk0001/ws/events`)
    ws().open()
    snap(term({ address: 'd1' }))
    expect([...s.terminals.value.keys()]).toEqual(['d1'])
    expect(hubStore.terminals.value.size).toBe(0)
    expect(s.conn.value).toBe('open')
  })

  it("does not take the hosts of a host's overview", async () => {
    routes['GET /h/h_desk0001/api/overview'] = () =>
      json(200, { ...DESK, hosts: [linkedHost({ id: 'h_lab00001', name: 'lab', url: 'https://lab.example.ts.net' })] })
    const s = linked()
    ws().open()
    snap()
    await vi.waitFor(() => expect(s.host.value?.name).toBe('desk'))
    expect(hosts.value.map((h) => h.id)).toEqual(['h_desk0001'])
  })

  it('closes the socket of a host taken off the list', () => {
    linked()
    const w = ws()
    hosts.value = []
    expect(w.closedWith).not.toBeNull()
    expect(scopeOf('h_desk0001')).toBeUndefined()
  })

  it('opens no stream for an unlinked host and says so', () => {
    const s = linked({ linked: false, version: '', relay: false })
    expect(FakeWebSocket.all).toHaveLength(0)
    expect(s.problem.value).toBe('unlinked')
  })

  it('goes to pairing on a 4401 when the hub forgot this device', async () => {
    routes['GET /api/hello'] = () => json(200, { ...HELLO, paired: false })
    const toPairing = vi.fn()
    onUnauthorized(toPairing)
    linked()
    ws().drop(4401)
    await vi.waitFor(() => expect(toPairing).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeWebSocket.all).toHaveLength(1)
  })

  it('marks only that host unlinked on a 4401 the hub still pairs', async () => {
    const toPairing = vi.fn()
    onUnauthorized(toPairing)
    const s = linked()
    ws().open()
    snap(term({ address: 'd1' }))
    routes['GET /h/h_desk0001/api/overview'] = () => json(409, { error: { kind: 'host_unlinked', message: 'desk 연결이 끊겼습니다' } })
    routes['GET /api/hosts'] = () => json(200, [linkedHost({ linked: false, version: '', relay: false })])
    ws().drop(4401)
    await vi.waitFor(() => expect(s.problem.value).toBe('unlinked'))
    expect(s.terminals.value.size).toBe(0)
    expect(toPairing).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeWebSocket.all).toHaveLength(1)
  })

  it("tries again after a 4401 while the hub's hello fails", async () => {
    routes['GET /api/hello'] = () => {
      throw new TypeError('offline')
    }
    linked()
    ws().drop(4401)
    await vi.advanceTimersByTimeAsync(499)
    expect(FakeWebSocket.all).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeWebSocket.all).toHaveLength(2)
  })

  it('reads the list again on a 4404', async () => {
    let reads = 0
    routes['GET /api/hosts'] = () => (reads++, json(200, []))
    linked()
    ws().drop(4404)
    await vi.waitFor(() => expect(reads).toBe(1))
    await vi.waitFor(() => expect(scopeOf('h_desk0001')).toBeUndefined())
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeWebSocket.all).toHaveLength(1)
  })

  it('shows a host out of reach on a 4502 until the next snapshot', async () => {
    const s = linked()
    ws().open()
    snap(term({ address: 'd1' }))
    ws().drop(4502)
    expect(s.problem.value).toBe('unreachable')
    expect([...s.terminals.value.keys()]).toEqual(['d1'])
    await vi.advanceTimersByTimeAsync(500)
    expect(FakeWebSocket.all).toHaveLength(2)
    ws().open()
    snap(term({ address: 'd1' }))
    expect(s.problem.value).toBeNull()
  })

  it('counts a REST 502 as out of reach until a retry gets through', async () => {
    const s = linked()
    ws().open()
    snap(term({ address: 'd1', status: status('blocked', { kind: 'permission' }) }))
    expect(s.needs.value).toBe(1)
    ws().drop(1006)
    routes['GET /h/h_desk0001/api/terminals'] = () => json(502, { error: { kind: 'host_unreachable', message: 'desk에 닿지 못했습니다' } })
    await s.api.terminals.list().catch(() => {})
    expect(s.problem.value).toBe('unreachable')
    expect(s.needs.value).toBe(0)
    routes['GET /h/h_desk0001/api/overview'] = () => json(200, DESK)
    s.retry()
    expect(FakeWebSocket.all).toHaveLength(2)
    await vi.waitFor(() => expect(s.problem.value).toBeNull())
  })

  it("adds up every host's needs, and one out of reach counts none", () => {
    hubStore.apply({ type: 'snapshot', core: { connected: true }, folders: [], terminals: [term({ status: status('blocked', { kind: 'permission' }) })] })
    const s = linked()
    ws().open()
    snap(term({ address: 'd1', status: status('idle') }), term({ address: 'd2', status: status('error', { msg: '중단됨' }) }))
    expect(totalNeeds.value).toBe(3)
    expect(s.counts.value).toMatchObject({ blocked: 0, error: 1, waiting: 1 })
    ws().drop(4502)
    expect(totalNeeds.value).toBe(1)
  })

  it('closes every stream when it stops', async () => {
    linked()
    const w = ws()
    stop()
    expect(w.closedWith).not.toBeNull()
    expect(scopes.value.size).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeWebSocket.all).toHaveLength(1)
  })
})
