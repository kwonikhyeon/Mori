import { describe, expect, it } from 'vitest'
import source from '../../public/sw.js?raw'

interface Shown {
  title: string
  options: NotificationOptions & { actions?: { action: string; title: string }[]; data?: unknown }
}

interface Win {
  url: string
  focused: number
  posted: unknown[]
}

/**
 * The service worker run in a fake scope: maxActions is what the browser
 * shows (undefined: no buttons at all), reply what the server answers.
 */
function worker(maxActions?: number, reply: () => Promise<Response> = async () => Response.json({})) {
  const on = new Map<string, (e: unknown) => void>()
  const shown: Shown[] = []
  const opened: string[] = []
  const wins: Win[] = []
  const fetches: { url: string; init: RequestInit }[] = []
  const scope = {
    location: { origin: 'https://mori.test' },
    Notification: maxActions === undefined ? undefined : { maxActions },
    addEventListener: (type: string, h: (e: unknown) => void) => on.set(type, h),
    skipWaiting: () => {},
    registration: {
      showNotification: async (title: string, options: Shown['options']) => {
        shown.push({ title, options })
      },
    },
    clients: {
      claim: async () => {},
      matchAll: async () =>
        wins.map((w) => ({
          url: w.url,
          focus: async () => {
            w.focused++
          },
          postMessage: (m: unknown) => w.posted.push(m),
        })),
      openWindow: async (url: string) => {
        opened.push(url)
      },
    },
  }
  const fetch = (url: string, init: RequestInit) => {
    fetches.push({ url, init })
    return reply()
  }
  new Function('self', 'fetch', source)(scope, fetch)
  const dispatch = async (type: string, e: object) => {
    const waits: Promise<unknown>[] = []
    on.get(type)!({ ...e, waitUntil: (p: Promise<unknown>) => waits.push(p) })
    await Promise.all(waits)
  }
  return {
    shown,
    opened,
    wins,
    fetches,
    push: (msg: object) => dispatch('push', { data: { json: () => msg, text: () => JSON.stringify(msg) } }),
    click: (data: unknown, action = '') => dispatch('notificationclick', { action, notification: { data, close: () => {} } }),
  }
}

const ASK = '4.0badc0de'
const question = { title: 'mac · 승인 대기', body: 'Claude Code — Bash?', tag: 't7', url: '/#/t/t7', kind: 'blocked', ask: ASK }

describe('the service worker', () => {
  it("offers a question's keys as buttons, as many as the browser shows", async () => {
    const keys = async (max?: number, msg: object = question) => {
      const w = worker(max)
      await w.push(msg)
      return w.shown[0].options.actions?.map((a) => [a.action, a.title])
    }
    expect(await keys(3)).toEqual([
      ['key:1', '1'],
      ['key:2', '2'],
      ['key:esc', 'Esc'],
    ])
    // with room for two, the first choice and Esc
    expect(await keys(2)).toEqual([
      ['key:1', '1'],
      ['key:esc', 'Esc'],
    ])
    expect(await keys(undefined)).toEqual([])
    // a question it cannot name, or no question, has none
    expect(await keys(3, { ...question, ask: undefined })).toEqual([])
    expect(await keys(3, { ...question, kind: 'waiting' })).toEqual([])
    const w = worker(3)
    await w.push(question)
    expect(w.shown[0].options.data).toEqual({ url: '/#/t/t7', ask: ASK })
  })

  it('answers from a button with the question it names, and opens nothing', async () => {
    const w = worker(3)
    await w.click({ url: '/#/t/mac%2Ft7', ask: ASK }, 'key:esc')
    await w.click({ url: '/#/h/h2/t/t7', ask: ASK }, 'key:2')
    expect(w.fetches.map((f) => [f.url, f.init.method, f.init.credentials, JSON.parse(String(f.init.body))])).toEqual([
      ['/api/terminals/mac%2Ft7/keys', 'POST', 'same-origin', { keys: ['esc'], expect: ASK }],
      ['/h/h2/api/terminals/t7/keys', 'POST', 'same-origin', { keys: ['2'], expect: ASK }],
    ])
    expect(w.opened).toEqual([])
  })

  it('opens the session when the answer does not go', async () => {
    const refused = worker(3, async () => Response.json({ error: { kind: 'changed' } }, { status: 409 }))
    await refused.click({ url: '/#/t/t7', ask: ASK }, 'key:1')
    expect(refused.opened).toEqual(['/#/t/t7'])

    const offline = worker(3, async () => {
      throw new TypeError('Failed to fetch')
    })
    offline.wins.push({ url: 'https://mori.test/#/folders', focused: 0, posted: [] })
    await offline.click({ url: '/#/t/t7', ask: ASK }, 'key:1')
    expect(offline.wins[0]).toEqual({ url: 'https://mori.test/#/folders', focused: 1, posted: [{ type: 'navigate', url: '/#/t/t7' }] })
    expect(offline.opened).toEqual([])
  })

  it('opens the session on a press of the notification itself', async () => {
    const w = worker(3)
    await w.click({ url: '/#/t/t7', ask: ASK })
    await w.click({ url: 'https://elsewhere.test/#/t/t7' })
    expect(w.fetches).toEqual([])
    expect(w.opened).toEqual(['/#/t/t7', '/'])
  })
})
