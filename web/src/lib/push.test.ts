import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './api'
import { disablePush, enablePush, fromB64url, loadKinds, pushSupport, readPush, saveKinds, setKinds } from './push'

// The server's key: base64url without padding of a 65-byte P-256 point.
const KEY_BYTES = Uint8Array.from({ length: 65 }, (_, i) => (i * 7 + 4) & 0xff)
const KEY = b64url(KEY_BYTES)
const OTHER = b64url(Uint8Array.from({ length: 65 }, (_, i) => (i * 3 + 1) & 0xff))

function b64url(b: Uint8Array): string {
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
}

type Sub = PushSubscription & { unsubscribe: ReturnType<typeof vi.fn> }

let log: string[]
let current: Sub | null
let posted: { url: string; method: string; body: unknown }[]
let serverList: { id: string; endpoint: string; kinds: string[]; created_ms: number }[]
let permission: NotificationPermission
let answer: NotificationPermission
let subscribeFails: boolean

function fakeSub(endpoint: string, key: Uint8Array | null): Sub {
  return {
    endpoint,
    options: { applicationServerKey: key ? key.slice().buffer : null, userVisibleOnly: true },
    toJSON: () => ({ endpoint, keys: { p256dh: 'P', auth: 'A' } }),
    unsubscribe: vi.fn(async () => {
      log.push('browser unsubscribe')
      if (current?.endpoint === endpoint) current = null
      return true
    }),
  } as unknown as Sub
}

const pushManager = {
  getSubscription: vi.fn(async () => current),
  subscribe: vi.fn(async (o: PushSubscriptionOptionsInit) => {
    log.push('subscribe')
    if (subscribeFails) throw new DOMException('no', 'AbortError')
    current = fakeSub('https://push.example/new', new Uint8Array(o.applicationServerKey as Uint8Array))
    return current
  }),
}
const reg = { pushManager }

function define(o: object, name: string, value: unknown) {
  Object.defineProperty(o, name, { value, configurable: true, writable: true })
}

beforeEach(() => {
  log = []
  current = null
  posted = []
  serverList = []
  permission = 'default'
  answer = 'granted'
  subscribeFails = false
  pushManager.getSubscription.mockClear()
  pushManager.subscribe.mockClear()
  localStorage.clear()
  vi.stubGlobal('isSecureContext', true)
  vi.stubGlobal('PushManager', function PushManager() {})
  vi.stubGlobal('Notification', {
    get permission() {
      return permission
    },
    requestPermission: vi.fn(async () => {
      log.push('permission')
      permission = answer
      return answer
    }),
  })
  define(navigator, 'serviceWorker', {
    register: vi.fn(async () => {
      log.push('register')
      return reg
    }),
    ready: Promise.resolve(reg),
    getRegistration: vi.fn(async () => reg),
  })
  define(navigator, 'userAgent', UA.mac)
  define(navigator, 'standalone', undefined)
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    log.push(`${init.method} ${url}`)
    posted.push({ url, method: String(init.method), body })
    if (init.method === 'POST' && url === '/api/push/subscriptions') {
      const view = { id: 's1', endpoint: body.subscription.endpoint, kinds: body.kinds, created_ms: 1 }
      serverList = [view]
      return new Response(JSON.stringify(view), { status: 201 })
    }
    if (init.method === 'DELETE') {
      serverList = []
      return new Response(null, { status: 204 })
    }
    return new Response(JSON.stringify(serverList), { status: 200 })
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  // @ts-expect-error: the fakes defined on navigator go with the test
  delete navigator.serviceWorker
  // @ts-expect-error: as above
  delete navigator.userAgent
  // @ts-expect-error: as above
  delete navigator.standalone
})

describe('pushSupport', () => {
  it('works on a secure page with a service worker and push', () => {
    expect(pushSupport()).toBe('ok')
  })

  it('needs https', () => {
    vi.stubGlobal('isSecureContext', false)
    expect(pushSupport()).toBe('insecure')
  })

  it('needs the home screen app on an iPhone', () => {
    define(navigator, 'userAgent', UA.iphone)
    vi.stubGlobal('PushManager', undefined)
    expect(pushSupport()).toBe('ios-browser')
    define(navigator, 'standalone', true)
    vi.stubGlobal('PushManager', function PushManager() {})
    expect(pushSupport()).toBe('ok')
  })

  it('says when the browser has no web push', () => {
    vi.stubGlobal('PushManager', undefined)
    expect(pushSupport()).toBe('unsupported')
    vi.stubGlobal('PushManager', function PushManager() {})
    vi.stubGlobal('Notification', undefined)
    expect(pushSupport()).toBe('unsupported')
    vi.stubGlobal('Notification', { permission: 'default' })
    define(navigator, 'serviceWorker', undefined)
    expect(pushSupport()).toBe('unsupported')
  })
})

describe('fromB64url', () => {
  it('reads the base64url the server writes, and plain base64 too', () => {
    expect([...fromB64url(KEY)]).toEqual([...KEY_BYTES])
    const std = btoa(String.fromCharCode(...KEY_BYTES))
    expect([...fromB64url(std)]).toEqual([...KEY_BYTES])
  })
})

describe('enablePush', () => {
  it('asks for permission first, in the same tap', async () => {
    const p = enablePush(KEY, ['blocked', 'error'])
    // iOS gives the prompt only while the tap is still being handled.
    expect(Notification.requestPermission).toHaveBeenCalledTimes(1)
    expect(log).toEqual(['permission'])
    await p
    expect(log[0]).toBe('permission')
  })

  it('subscribes with the server key and sends the subscription and kinds', async () => {
    const view = await enablePush(KEY, ['blocked', 'error'])
    const opts = pushManager.subscribe.mock.calls[0][0]
    expect(opts.userVisibleOnly).toBe(true)
    expect([...new Uint8Array(opts.applicationServerKey as Uint8Array)]).toEqual([...KEY_BYTES])
    const post = posted.find((c) => c.method === 'POST')!
    expect(post.body).toEqual({ subscription: { endpoint: 'https://push.example/new', keys: { p256dh: 'P', auth: 'A' } }, kinds: ['blocked', 'error'] })
    expect(view.kinds).toEqual(['blocked', 'error'])
  })

  it('keeps a subscription made with the same key', async () => {
    current = fakeSub('https://push.example/old', KEY_BYTES)
    const old = current
    await enablePush(KEY, ['waiting'])
    expect(pushManager.subscribe).not.toHaveBeenCalled()
    expect(old.unsubscribe).not.toHaveBeenCalled()
    expect(posted.find((c) => c.method === 'POST')!.body).toMatchObject({ subscription: { endpoint: 'https://push.example/old' } })
  })

  it('drops a subscription made with another key and subscribes again', async () => {
    current = fakeSub('https://push.example/old', fromB64url(OTHER))
    const old = current
    await enablePush(KEY, ['waiting'])
    expect(old.unsubscribe).toHaveBeenCalled()
    expect(log.indexOf('browser unsubscribe')).toBeLessThan(log.indexOf('subscribe'))
    expect(posted.find((c) => c.method === 'POST')!.body).toMatchObject({ subscription: { endpoint: 'https://push.example/new' } })
  })

  it('stops when notifications are not allowed', async () => {
    answer = 'denied'
    await expect(enablePush(KEY, ['blocked'])).rejects.toThrow('브라우저의 사이트 설정에서 알림을 허용하세요')
    answer = 'default'
    await expect(enablePush(KEY, ['blocked'])).rejects.toThrow('알림을 허용하지 않았습니다')
    expect(pushManager.subscribe).not.toHaveBeenCalled()
    expect(posted).toEqual([])
  })

  it('says when the browser cannot subscribe', async () => {
    subscribeFails = true
    const e = await enablePush(KEY, ['blocked']).catch((e) => e)
    expect(e).toBeInstanceOf(ApiError)
    expect(e.message).toBe('브라우저가 알림 구독을 만들지 못했습니다')
    expect(posted).toEqual([])
  })
})

describe('disablePush', () => {
  it('tells the server first, then drops the browser subscription', async () => {
    current = fakeSub('https://push.example/old', KEY_BYTES)
    await disablePush()
    expect(log).toEqual(['DELETE /api/push/subscriptions', 'browser unsubscribe'])
    expect(posted[0].body).toEqual({ endpoint: '' })
    expect(current).toBeNull()
  })

  it('keeps the browser subscription when the server cannot be reached', async () => {
    current = fakeSub('https://push.example/old', KEY_BYTES)
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))))
    await expect(disablePush()).rejects.toThrow('서버에 연결할 수 없습니다')
    expect(current).not.toBeNull()
  })
})

describe('setKinds', () => {
  it('sends the same subscription with the new kinds', async () => {
    current = fakeSub('https://push.example/old', KEY_BYTES)
    const view = await setKinds(['error', 'exited'])
    expect(posted[0].body).toMatchObject({ subscription: { endpoint: 'https://push.example/old' }, kinds: ['error', 'exited'] })
    expect(view.kinds).toEqual(['error', 'exited'])
  })

  it('says so when the browser lost the subscription', async () => {
    await expect(setKinds(['error'])).rejects.toThrow('알림을 다시 켜 주세요')
    expect(posted).toEqual([])
  })
})

describe('readPush', () => {
  it('is on when the browser and the server have the same subscription', async () => {
    permission = 'granted'
    current = fakeSub('https://push.example/old', KEY_BYTES)
    serverList = [{ id: 's1', endpoint: 'https://push.example/old', kinds: ['blocked'], created_ms: 1 }]
    expect(await readPush(KEY)).toEqual({ on: serverList[0], permission: 'granted' })
  })

  it('is off when the server forgot the subscription', async () => {
    permission = 'granted'
    current = fakeSub('https://push.example/old', KEY_BYTES)
    serverList = [{ id: 's9', endpoint: 'https://push.example/other', kinds: ['blocked'], created_ms: 1 }]
    expect((await readPush(KEY)).on).toBeNull()
  })

  it('is off for a subscription made with another key, without asking the server', async () => {
    permission = 'granted'
    current = fakeSub('https://push.example/old', fromB64url(OTHER))
    expect((await readPush(KEY)).on).toBeNull()
    expect(posted).toEqual([])
  })

  it('is off without permission, and says which', async () => {
    permission = 'denied'
    current = fakeSub('https://push.example/old', KEY_BYTES)
    expect(await readPush(KEY)).toEqual({ on: null, permission: 'denied' })
  })

  it('is off before the service worker is registered', async () => {
    permission = 'granted'
    define(navigator, 'serviceWorker', { getRegistration: vi.fn(async () => undefined) })
    expect((await readPush(KEY)).on).toBeNull()
  })
})

describe('kinds on this device', () => {
  it('starts with the server defaults and keeps what was chosen, in order', () => {
    expect(loadKinds()).toEqual(['blocked', 'waiting', 'error'])
    saveKinds(['exited', 'blocked'])
    expect(loadKinds()).toEqual(['blocked', 'exited'])
    saveKinds([])
    expect(loadKinds()).toEqual([])
  })

  it('ignores what it does not know', () => {
    localStorage.setItem('mori.push.kinds', JSON.stringify(['error', 'nope', 3]))
    expect(loadKinds()).toEqual(['error'])
    localStorage.setItem('mori.push.kinds', '{"a":1}')
    expect(loadKinds()).toEqual(['blocked', 'waiting', 'error'])
  })
})
