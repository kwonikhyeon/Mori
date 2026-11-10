import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeWebSocket } from '../../test/fakeWs'
import { linkedHost, term } from '../../test/fixtures'
import { request } from './api'
import { boot, hello, hostLabel, paired, phase, refusal, shutdown } from './boot'
import { route } from './router'
import { host, resetStore, terminals } from './store'

type Reply = () => Response | Promise<Response>

let routes: Record<string, Reply>
let calls: string[]

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const HELLO = { app: 'mori', version: '0.1.0', host: 'macmini', paired: true }
const OVERVIEW = {
  host: { name: 'macmini', version: '0.1.0' },
  core: { connected: true },
  folders: [],
  terminals: [],
  presets: [{ id: 'claude', name: 'Claude Code', argv: ['claude'], task: true }],
  hosts: [],
}

beforeEach(() => {
  calls = []
  routes = {
    'GET /api/hello': () => json(200, HELLO),
    'GET /api/overview': () => json(200, OVERVIEW),
  }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const key = `${init.method} ${url}`
    calls.push(key)
    const r = routes[key]
    return r ? r() : json(404, { error: { kind: 'not_found', message: '없습니다' } })
  }))
  FakeWebSocket.reset()
  vi.stubGlobal('WebSocket', FakeWebSocket)
  history.replaceState(null, '', '/')
})

afterEach(() => {
  shutdown()
  resetStore()
  phase.value = 'loading'
  hello.value = null
  refusal.value = null
  vi.unstubAllGlobals()
})

const snapshot = (ts = [term()]) => ({ type: 'snapshot', core: { connected: true }, folders: [], terminals: ts })

describe('boot', () => {
  it('opens the event stream for a paired device', async () => {
    await boot()
    expect(phase.value).toBe('app')
    expect(FakeWebSocket.all).toHaveLength(1)
    expect(new URL(FakeWebSocket.last().url).pathname).toBe('/ws/events')
    expect(hostLabel.value).toBe('macmini')
  })

  it('shows pairing without a socket for a device that is not paired', async () => {
    routes['GET /api/hello'] = () => json(200, { ...HELLO, paired: false })
    await boot()
    expect(phase.value).toBe('pair')
    expect(FakeWebSocket.all).toHaveLength(0)
  })

  it('stops at an address the server does not answer to', async () => {
    const refused = { kind: 'bad_host', message: '이 주소로는 Mori에 들어올 수 없습니다', hint: 'Tailscale 이름으로 여세요' }
    routes['GET /api/hello'] = () => json(421, { error: refused })
    await boot()
    expect(phase.value).toBe('refused')
    expect(refusal.value).toMatchObject({ status: 421, ...refused })
    expect(FakeWebSocket.all).toHaveLength(0)
  })

  it('tries the stream when the server cannot be asked', async () => {
    routes['GET /api/hello'] = () => Promise.reject(new TypeError('offline'))
    await boot()
    expect(phase.value).toBe('app')
    expect(FakeWebSocket.all).toHaveLength(1)
  })

  it('asks for the overview on every open', async () => {
    await boot()
    const ws = FakeWebSocket.last()
    ws.open()
    ws.json(snapshot())
    await vi.waitFor(() => expect(host.value?.name).toBe('macmini'))
    expect(calls.filter((c) => c === 'GET /api/overview')).toHaveLength(1)
  })

  it('goes back to pairing on 4401 and forgets what it knew', async () => {
    await boot()
    const ws = FakeWebSocket.last()
    ws.open()
    ws.json(snapshot())
    expect(terminals.value.size).toBe(1)
    routes['GET /api/hello'] = () => json(200, { ...HELLO, host: 'macmini2', paired: false })
    ws.drop(4401)
    expect(phase.value).toBe('pair')
    expect(terminals.value.size).toBe(0)
    await vi.waitFor(() => expect(hello.value?.host).toBe('macmini2'))
    expect(FakeWebSocket.all).toHaveLength(1)
  })

  it('goes back to pairing when a call says unauthorized', async () => {
    await boot()
    routes['GET /api/devices'] = () => json(401, { error: { kind: 'unauthorized', message: '이 기기는 페어링되지 않았습니다' } })
    await request('GET', '/api/devices').catch(() => {})
    expect(phase.value).toBe('pair')
    expect(FakeWebSocket.last().closedWith).not.toBeNull()
  })

  it('opens a stream for each linked host', async () => {
    routes['GET /api/overview'] = () => json(200, { ...OVERVIEW, hosts: [linkedHost()] })
    await boot()
    FakeWebSocket.last().open()
    FakeWebSocket.last().json(snapshot())
    await vi.waitFor(() =>
      expect(FakeWebSocket.all.map((w) => new URL(w.url).pathname)).toEqual(['/ws/events', '/h/h_desk0001/ws/events']),
    )
  })

  it('leaves /pair for the app once the device is paired', async () => {
    history.replaceState(null, '', '/pair#code=ABCD-EFGH')
    await boot()
    expect(location.pathname).toBe('/')
    expect(location.hash).toBe('#/')
    expect(route.value).toEqual({ name: 'queue' })
  })
})

describe('paired', () => {
  it('cleans the pairing link out of the address and starts', async () => {
    routes['GET /api/hello'] = () => json(200, { ...HELLO, paired: false })
    history.replaceState(null, '', '/pair#code=ABCD-EFGH')
    await boot()
    expect(phase.value).toBe('pair')
    paired()
    expect(location.pathname).toBe('/')
    expect(location.hash).toBe('#/')
    expect(phase.value).toBe('app')
    expect(hello.value?.paired).toBe(true)
    expect(FakeWebSocket.all).toHaveLength(1)
  })

  it('keeps the route a device came for', async () => {
    routes['GET /api/hello'] = () => json(200, { ...HELLO, paired: false })
    history.replaceState(null, '', '/#/t/t7')
    await boot()
    paired()
    expect(location.hash).toBe('#/t/t7')
    expect(route.value).toEqual({ name: 'terminal', addr: 't7', git: false })
  })
})
