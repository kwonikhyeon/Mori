import { cleanup, fireEvent, render, screen } from '@testing-library/preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../lib/api'
import { disablePush, enablePush, pushSupport, readPush, setKinds } from '../lib/push'
import { resetStore } from '../lib/store'
import { toasts } from '../lib/toast'
import type { PushKind, PushSubscriptionView } from '../lib/types'
import { PushCards } from './SettingsPush'

// The browser's side of push is lib/push's, tested there.
vi.mock('../lib/push', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/push')>()
  return { ...real, pushSupport: vi.fn(), enablePush: vi.fn(), disablePush: vi.fn(), setKinds: vi.fn(), readPush: vi.fn() }
})

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
}

interface Call {
  method: string
  path: string
  body: unknown
}

let calls: Call[] = []
let reply: (c: Call) => Response | undefined = () => undefined
let children = false

const sub = (kinds: PushKind[] = []): PushSubscriptionView => ({ id: 's1', endpoint: 'https://push.example/1', kinds, created_ms: 1 })
const unavailable = () => Response.json({ error: { kind: 'unavailable', message: '이 서버는 알림을 보내지 않습니다' } }, { status: 503 })

function server(c: Call): Response | undefined {
  if (c.path === '/api/push/key') return Response.json({ key: 'K' })
  if (c.path === '/api/push/settings') {
    if (c.method === 'PUT') children = (c.body as { children: boolean }).children
    return Response.json({ children })
  }
  if (c.path === '/api/push/test') return Response.json({ sent: 1 })
  return undefined
}

const toastTexts = () => toasts.value.map((t) => [t.text, t.kind])
const toggle = () => screen.getByRole('switch', { name: '이 기기에서 알림 받기' }) as HTMLInputElement
const kind = (name: string) => screen.getByRole('checkbox', { name }) as HTMLInputElement
const kindsShown = () => ['승인 대기', '입력 대기', '오류', '종료'].filter((n) => kind(n).checked)
const childrenBox = () => screen.getByRole('switch', { name: '하위 터미널도 알림' }) as HTMLInputElement
const testBtn = () => screen.getByRole('button', { name: '시험 알림 보내기' }) as HTMLButtonElement
const described = (el: Element) => document.getElementById(el.getAttribute('aria-describedby') ?? '')?.textContent

function userAgent(ua: string) {
  Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true, writable: true })
}

/** Renders with notifications off and waits for the server's answer. */
async function shown() {
  render(<PushCards />)
  await vi.waitFor(() => expect(toggle().disabled).toBe(false))
}

beforeEach(() => {
  calls = []
  children = false
  reply = server
  toasts.value = []
  localStorage.clear()
  userAgent(UA.mac)
  vi.mocked(pushSupport).mockReset().mockReturnValue('ok')
  vi.mocked(readPush).mockReset().mockResolvedValue({ on: null, permission: 'default' })
  vi.mocked(enablePush).mockReset()
  vi.mocked(disablePush).mockReset().mockResolvedValue(undefined)
  vi.mocked(setKinds).mockReset()
  vi.stubGlobal('Notification', { permission: 'default' })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const u = new URL(String(url), 'http://mori.test')
      const raw = init.body
      const c = { method: init.method ?? 'GET', path: u.pathname, body: typeof raw === 'string' ? JSON.parse(raw) : undefined }
      calls.push(c)
      return reply(c) ?? Response.json({})
    }),
  )
})

afterEach(() => {
  cleanup()
  resetStore()
  toasts.value = []
  vi.unstubAllGlobals()
})

describe('PushCards', () => {
  it("shows this device's notifications as the browser and the server have them", async () => {
    vi.mocked(readPush).mockResolvedValue({ on: sub(['blocked', 'error']), permission: 'granted' })
    render(<PushCards />)
    await vi.waitFor(() => expect(toggle().checked).toBe(true))
    expect(vi.mocked(readPush)).toHaveBeenCalledWith('K')
    expect(described(toggle())).toBe('Mac · Chrome')
    expect(kindsShown()).toEqual(['승인 대기', '오류'])
    expect(testBtn().disabled).toBe(false)
    // The host's setting is read on its own.
    await vi.waitFor(() => expect(childrenBox().disabled).toBe(false))
    expect(childrenBox().checked).toBe(false)
  })

  it('shows the server defaults for a subscription that names no kinds', async () => {
    vi.mocked(readPush).mockResolvedValue({ on: sub([]), permission: 'granted' })
    render(<PushCards />)
    await vi.waitFor(() => expect(toggle().checked).toBe(true))
    expect(kindsShown()).toEqual(['승인 대기', '입력 대기', '오류'])
  })

  it('turns notifications on straight from the tap, with the kinds chosen while off', async () => {
    localStorage.setItem('mori.push.kinds', JSON.stringify(['blocked', 'exited']))
    let done!: (v: PushSubscriptionView) => void
    vi.mocked(enablePush).mockReturnValue(new Promise((r) => (done = r)))
    await shown()
    expect(kindsShown()).toEqual(['승인 대기', '종료'])
    expect(testBtn().disabled).toBe(true)
    expect(described(testBtn())).toBe('이 기기에서 알림을 켜면 보낼 수 있습니다.')

    fireEvent.click(toggle())
    // Before anything is awaited: iOS asks for the permission only then.
    expect(vi.mocked(enablePush)).toHaveBeenCalledWith('K', ['blocked', 'exited'])
    expect(toggle().checked).toBe(true)

    vi.stubGlobal('Notification', { permission: 'granted' })
    done(sub(['blocked', 'exited']))
    await vi.waitFor(() => expect(toastTexts()).toEqual([['이 기기에서 알림을 켰습니다', 'info']]))
    expect(toggle().checked).toBe(true)
    expect(testBtn().disabled).toBe(false)
  })

  it('stays off when notifications cannot be turned on', async () => {
    vi.mocked(enablePush).mockRejectedValue(new ApiError(0, 'permission', '알림을 허용하지 않았습니다'))
    await shown()
    fireEvent.click(toggle())
    await vi.waitFor(() => expect(toastTexts()).toEqual([['알림을 허용하지 않았습니다', 'error']]))
    expect(toggle().checked).toBe(false)
  })

  it('turns notifications off', async () => {
    vi.mocked(readPush).mockResolvedValue({ on: sub(), permission: 'granted' })
    vi.stubGlobal('Notification', { permission: 'granted' })
    render(<PushCards />)
    await vi.waitFor(() => expect(toggle().checked).toBe(true))
    fireEvent.click(toggle())
    expect(vi.mocked(disablePush)).toHaveBeenCalled()
    await vi.waitFor(() => expect(toastTexts()).toEqual([['이 기기에서 알림을 껐습니다', 'info']]))
    expect(toggle().checked).toBe(false)
    expect(testBtn().disabled).toBe(true)
  })

  it('changes the kinds of a device that has notifications on', async () => {
    vi.mocked(readPush).mockResolvedValue({ on: sub(['blocked', 'waiting', 'error']), permission: 'granted' })
    vi.mocked(setKinds).mockImplementation(async (ks) => sub(ks))
    render(<PushCards />)
    await vi.waitFor(() => expect(toggle().checked).toBe(true))
    fireEvent.click(kind('종료'))
    expect(vi.mocked(setKinds)).toHaveBeenCalledWith(['blocked', 'waiting', 'error', 'exited'])
    await vi.waitFor(() => expect(JSON.parse(localStorage.getItem('mori.push.kinds')!)).toEqual(['blocked', 'waiting', 'error', 'exited']))
    expect(kindsShown()).toEqual(['승인 대기', '입력 대기', '오류', '종료'])
    // Said by the box itself: no note for it.
    expect(toastTexts()).toEqual([])
  })

  it('turns notifications off when the last kind goes, rather than fall back to the defaults', async () => {
    vi.mocked(readPush).mockResolvedValue({ on: sub(['error']), permission: 'granted' })
    vi.stubGlobal('Notification', { permission: 'granted' })
    render(<PushCards />)
    await vi.waitFor(() => expect(toggle().checked).toBe(true))
    fireEvent.click(kind('오류'))
    expect(vi.mocked(setKinds)).not.toHaveBeenCalled()
    expect(vi.mocked(disablePush)).toHaveBeenCalled()
    await vi.waitFor(() => expect(toastTexts()).toEqual([['알릴 상태를 모두 꺼서 이 기기의 알림을 껐습니다', 'info']]))
    expect(toggle().checked).toBe(false)
    expect(kindsShown()).toEqual([])
    expect(JSON.parse(localStorage.getItem('mori.push.kinds')!)).toEqual([])
  })

  it('keeps the kinds on this device while its notifications are off', async () => {
    await shown()
    fireEvent.click(kind('종료'))
    expect(vi.mocked(setKinds)).not.toHaveBeenCalled()
    expect(kindsShown()).toEqual(['승인 대기', '입력 대기', '오류', '종료'])
    expect(JSON.parse(localStorage.getItem('mori.push.kinds')!)).toEqual(['blocked', 'waiting', 'error', 'exited'])
  })

  it('says so when the kinds could not be changed, and reads them again', async () => {
    vi.mocked(readPush).mockResolvedValue({ on: sub(['blocked']), permission: 'granted' })
    vi.mocked(setKinds).mockRejectedValue(new ApiError(0, 'gone', '이 기기의 알림 구독이 없습니다. 알림을 다시 켜 주세요'))
    render(<PushCards />)
    await vi.waitFor(() => expect(toggle().checked).toBe(true))
    vi.mocked(readPush).mockResolvedValue({ on: null, permission: 'granted' })
    fireEvent.click(kind('오류'))
    await vi.waitFor(() => expect(toastTexts()).toEqual([['이 기기의 알림 구독이 없습니다. 알림을 다시 켜 주세요', 'error']]))
    await vi.waitFor(() => expect(toggle().checked).toBe(false))
    expect(vi.mocked(readPush)).toHaveBeenCalledTimes(2)
  })

  it('sends the children of sessions too, for the whole host', async () => {
    await shown()
    fireEvent.click(await screen.findByRole('switch', { name: '하위 터미널도 알림' }))
    await vi.waitFor(() => expect(calls.find((c) => c.method === 'PUT')).toEqual({ method: 'PUT', path: '/api/push/settings', body: { children: true } }))
    await vi.waitFor(() => expect(childrenBox().checked).toBe(true))
    expect(toastTexts()).toEqual([])
  })

  it('sends a test notification', async () => {
    vi.mocked(readPush).mockResolvedValue({ on: sub(), permission: 'granted' })
    render(<PushCards />)
    await vi.waitFor(() => expect(testBtn().disabled).toBe(false))
    fireEvent.click(testBtn())
    expect(screen.getByRole('button', { name: '보내는 중…' })).toBeTruthy()
    await vi.waitFor(() => expect(toastTexts()).toEqual([['시험 알림을 보냈습니다', 'info']]))
    expect(calls.filter((c) => c.path === '/api/push/test').map((c) => c.method)).toEqual(['POST'])
  })

  it('reads the state again when the push service has dropped the subscription', async () => {
    vi.mocked(readPush).mockResolvedValue({ on: sub(), permission: 'granted' })
    render(<PushCards />)
    await vi.waitFor(() => expect(testBtn().disabled).toBe(false))
    const gone = '이 기기의 알림 구독이 만료되어 지웠습니다. 알림을 다시 켜 주세요 (푸시 서비스 응답 410)'
    reply = (c) => (c.path === '/api/push/test' ? Response.json({ error: { kind: 'expired', message: gone } }, { status: 502 }) : server(c))
    vi.mocked(readPush).mockResolvedValue({ on: null, permission: 'granted' })
    fireEvent.click(testBtn())
    await vi.waitFor(() => expect(toastTexts()).toEqual([[gone, 'error']]))
    await vi.waitFor(() => expect(toggle().checked).toBe(false))
    expect(testBtn().disabled).toBe(true)
  })

  it('says when this server sends no notifications, and leaves everything off', async () => {
    reply = (c) => (c.path.startsWith('/api/push/') ? unavailable() : undefined)
    render(<PushCards />)
    expect(await screen.findByText('이 서버는 알림을 보내지 않습니다')).toBeTruthy()
    expect(toggle().disabled).toBe(true)
    expect(kind('승인 대기').matches(':disabled')).toBe(true)
    await vi.waitFor(() => expect(childrenBox().disabled).toBe(true))
    expect(testBtn().disabled).toBe(true)
    expect(vi.mocked(readPush)).not.toHaveBeenCalled()
  })

  it('says when the browser has blocked notifications, and where to allow them', async () => {
    vi.mocked(readPush).mockResolvedValue({ on: null, permission: 'denied' })
    render(<PushCards />)
    expect(await screen.findByText('알림이 막혀 있습니다')).toBeTruthy()
    expect(screen.getByText('브라우저의 사이트 설정에서 이 사이트의 알림을 허용하면 여기서 켤 수 있습니다.')).toBeTruthy()
    expect(toggle().disabled).toBe(true)
    expect(kind('오류').matches(':disabled')).toBe(true)
    // The host's setting is not this browser's.
    await vi.waitFor(() => expect(childrenBox().disabled).toBe(false))
  })

  it('needs https', async () => {
    vi.mocked(pushSupport).mockReturnValue('insecure')
    render(<PushCards />)
    expect(await screen.findByText('https 주소에서만 알림을 켤 수 있습니다')).toBeTruthy()
    expect(screen.getByText('브라우저는 https 주소에서만 웹 알림을 허락합니다. Tailscale의 https 주소로 여세요.')).toBeTruthy()
    await vi.waitFor(() => expect(childrenBox().disabled).toBe(false))
    expect(toggle().disabled).toBe(true)
    expect(vi.mocked(readPush)).not.toHaveBeenCalled()
  })

  it('sends an iPhone to the home screen app', async () => {
    userAgent(UA.iphone)
    vi.mocked(pushSupport).mockReturnValue('ios-browser')
    render(<PushCards />)
    expect(await screen.findByText('홈 화면에 추가한 앱에서만 켤 수 있습니다')).toBeTruthy()
    expect(
      screen.getByText('iPhone은 홈 화면에 추가한 앱에서만 알림을 받습니다. Safari의 공유 → 홈 화면에 추가로 앱을 만든 뒤 거기서 켜세요.'),
    ).toBeTruthy()
    expect(toggle().disabled).toBe(true)
  })
})
