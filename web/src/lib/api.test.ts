import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  api, ApiError, apiFor, hostPrefix, hubUnpaired, onUnauthorized, READ_LIMIT, request, termPath, UPLOAD_LIMIT, WRITE_LIMIT, wsURL,
  type HostApi,
} from './api'

type Call = { url: string; init: RequestInit }

let calls: Call[]
let reply: () => Response

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  calls = []
  reply = () => json(200, {})
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return reply()
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  onUnauthorized(null)
})

describe('request', () => {
  it('sends JSON with the cookie of this origin', async () => {
    reply = () => json(201, { address: 't1' })
    const t = await request<{ address: string }>('POST', '/api/terminals', { folder_id: 'f1', preset: 'shell' })
    expect(t.address).toBe('t1')
    const { init } = calls[0]
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('same-origin')
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json')
    expect(JSON.parse(String(init.body))).toEqual({ folder_id: 'f1', preset: 'shell' })
  })

  it('gives nothing for 204', async () => {
    reply = () => new Response(null, { status: 204 })
    await expect(request('DELETE', '/api/terminals/t1')).resolves.toBeUndefined()
  })

  it('turns the error body into an ApiError', async () => {
    reply = () => json(409, { error: { kind: 'blocked', message: '승인을 기다리는 중입니다', hint: '키로 답하세요' } })
    const err = await request('POST', '/api/terminals/t1/send', { text: 'x' }).catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 409, kind: 'blocked', message: '승인을 기다리는 중입니다', hint: '키로 답하세요' })
  })

  it('names the status when the body is not ours', async () => {
    reply = () => new Response('<html>bad gateway</html>', { status: 502 })
    const err = await request('GET', '/api/overview').catch((e) => e)
    expect(err).toMatchObject({ status: 502, kind: 'http', message: '요청이 실패했습니다 (502)' })
  })

  it('says the server is out of reach when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const err = await request('GET', '/api/overview').catch((e) => e)
    expect(err).toMatchObject({ status: 0, kind: 'network', message: '서버에 연결할 수 없습니다' })
  })

  it('gives up on a server that does not answer in time', async () => {
    vi.useFakeTimers()
    try {
      // fetch rejects when its signal aborts, as the browser's does
      vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
        calls.push({ url, init })
        return new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
      }))
      const at = (method: string, body?: unknown) => request(method, '/api/x', body).catch((e) => e)
      const read = at('GET')
      const write = at('POST', { text: 'x' })
      const upload = at('POST', new FormData())
      await vi.advanceTimersByTimeAsync(READ_LIMIT - 1)
      expect(calls.map((c) => c.init.signal?.aborted)).toEqual([false, false, false])
      await vi.advanceTimersByTimeAsync(1)
      expect(await read).toMatchObject({ status: 0, kind: 'timeout', message: '서버가 제때 답하지 않았습니다' })
      await vi.advanceTimersByTimeAsync(WRITE_LIMIT - READ_LIMIT)
      expect(await write).toMatchObject({ kind: 'timeout' })
      expect(calls[2].init.signal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(UPLOAD_LIMIT - WRITE_LIMIT)
      expect(await upload).toMatchObject({ kind: 'timeout' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops the clock once the answer came', async () => {
    vi.useFakeTimers()
    try {
      await request('GET', '/api/overview')
      expect(vi.getTimerCount()).toBe(0)
      reply = () => json(500, {})
      await request('POST', '/api/logout').catch(() => {})
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('calls the unauthorized hook for an unpaired device only', async () => {
    const hook = vi.fn()
    onUnauthorized(hook)
    reply = () => json(401, { error: { kind: 'unauthorized', message: '이 기기는 페어링되지 않았습니다' } })
    await request('GET', '/api/overview').catch(() => {})
    expect(hook).toHaveBeenCalledTimes(1)
    reply = () => json(403, { error: { kind: 'forbidden_origin', message: 'x' } })
    await request('POST', '/api/logout').catch(() => {})
    expect(hook).toHaveBeenCalledTimes(1)
  })
})

describe('paths', () => {
  it('keeps a / in an address inside one segment', () => {
    expect(termPath('machine/t7')).toBe('/api/terminals/machine%2Ft7')
    expect(termPath('t1')).toBe('/api/terminals/t1')
  })

  it('puts the address of another machine into one path segment', async () => {
    await api.terminals.send('machine/t7', 'hello')
    expect(calls[0].url).toBe('/api/terminals/machine%2Ft7/send')
  })

  it('names the question an answer is for only when there is one', async () => {
    await api.terminals.keys('t1', ['1'], '1.0badc0de')
    await api.terminals.keys('t1', ['enter'])
    await api.terminals.reject('machine/t7', '대신 테스트만 돌려', '2.0badc0de')
    expect(calls.map((c) => [c.url, JSON.parse(String(c.init.body))])).toEqual([
      ['/api/terminals/t1/keys', { keys: ['1'], expect: '1.0badc0de' }],
      ['/api/terminals/t1/keys', { keys: ['enter'] }],
      ['/api/terminals/machine%2Ft7/reject', { text: '대신 테스트만 돌려', expect: '2.0badc0de' }],
    ])
  })

  it('carries Korean and spaces in a query and back', async () => {
    reply = () => json(200, { head: 'abc', branch: 'main', detached: false, upstream: '', ahead: 0, behind: 0, changes: [] })
    const path = '/Users/me/내 프로젝트/a+b'
    await api.git.status(path)
    const url = new URL(calls[0].url, 'http://x')
    expect(url.pathname).toBe('/api/git/status')
    expect(url.searchParams.get('path')).toBe(path)
  })

  it('leaves out empty and false query values and writes true as 1', async () => {
    await api.git.log('/r', { limit: 400, head: true })
    expect(calls[0].url).toBe('/api/git/log?path=%2Fr&limit=400&head=1')
    await api.git.log('/r', { head: false })
    expect(calls[1].url).toBe('/api/git/log?path=%2Fr')
    await api.folders.removeWorktree('f 1', '/r.wt/x', false)
    expect(calls[2].url).toBe('/api/folders/f%201/worktrees?path=%2Fr.wt%2Fx')
    expect(calls[2].init.method).toBe('DELETE')
  })

  it('sends a file as multipart without a JSON type', async () => {
    reply = () => json(200, { path: '/tmp/a.png', bytes: 3 })
    const up = await api.terminals.upload('t1', new File(['abc'], 'a.png'))
    expect(up.path).toBe('/tmp/a.png')
    const { init } = calls[0]
    expect(init.body).toBeInstanceOf(FormData)
    expect((init.body as FormData).get('file')).toBeInstanceOf(File)
    expect(new Headers(init.headers).get('Content-Type')).toBeNull()
  })

  it('makes WebSocket addresses of this host', () => {
    expect(wsURL('/ws/events', { protocol: 'https:', host: 'macmini.example.ts.net' })).toBe('wss://macmini.example.ts.net/ws/events')
    expect(wsURL('/ws/events', { protocol: 'http:', host: '127.0.0.1:7761' })).toBe('ws://127.0.0.1:7761/ws/events')
  })
})

describe('another host', () => {
  let desk: HostApi
  beforeEach(() => {
    desk = apiFor(hostPrefix('h_desk0001'))
  })

  it('goes through the hub under /h/<ID>', async () => {
    await desk.terminals.send('machine/t7', 'hello')
    await desk.git.log('/r', { head: true })
    await desk.overview()
    expect(calls.map((c) => c.url)).toEqual([
      '/h/h_desk0001/api/terminals/machine%2Ft7/send',
      '/h/h_desk0001/api/git/log?path=%2Fr&head=1',
      '/h/h_desk0001/api/overview',
    ])
  })

  it('keeps the hub at its own paths', async () => {
    await api.overview()
    await api.push.key()
    await api.hosts.get()
    expect(calls.map((c) => c.url)).toEqual(['/api/overview', '/api/push/key', '/api/hosts'])
    expect(hostPrefix('')).toBe('')
    expect(hostPrefix('h 1')).toBe('/h/h%201')
  })

  it('links, renames, relays and unlinks a host', async () => {
    await api.hosts.link('https://desk.example.ts.net', 'ABCD-EFGH', '책상')
    await api.hosts.rename('h_desk0001', 'desk')
    await api.hosts.relay('h_desk0001')
    await api.hosts.unlink('h_desk0001')
    expect(calls.map((c) => [c.init.method, c.url, c.init.body])).toEqual([
      ['POST', '/api/hosts', JSON.stringify({ url: 'https://desk.example.ts.net', code: 'ABCD-EFGH', name: '책상' })],
      ['PATCH', '/api/hosts/h_desk0001', JSON.stringify({ name: 'desk' })],
      ['POST', '/api/hosts/h_desk0001/relay', undefined],
      ['DELETE', '/api/hosts/h_desk0001', undefined],
    ])
  })

  it('has only what the hub relays', () => {
    expect(Object.keys(desk).sort()).toEqual(['folders', 'fs', 'git', 'hello', 'overview', 'presets', 'push', 'terminals'])
    expect(Object.keys(desk.push).sort()).toEqual(['putSettings', 'settings'])
  })

  it('tells when the hub says the host is unlinked or out of reach', async () => {
    const seen: string[] = []
    const d = apiFor(hostPrefix('h_desk0001'), (k) => seen.push(k))
    for (const [status, kind] of [[409, 'host_unlinked'], [502, 'host_unreachable'], [404, 'not_found']] as const) {
      reply = () => json(status, { error: { kind, message: '안 됩니다' } })
      await expect(d.overview()).rejects.toMatchObject({ status, kind })
    }
    expect(seen).toEqual(['host_unlinked', 'host_unreachable'])
  })

  it('takes a 401 under /h/ as the hub forgetting this device', async () => {
    const hook = vi.fn()
    onUnauthorized(hook)
    reply = () => json(401, { error: { kind: 'unauthorized', message: '페어링이 필요합니다' } })
    await expect(desk.overview()).rejects.toBeInstanceOf(ApiError)
    expect(hook).toHaveBeenCalledTimes(1)
    hubUnpaired()
    expect(hook).toHaveBeenCalledTimes(2)
  })
})
