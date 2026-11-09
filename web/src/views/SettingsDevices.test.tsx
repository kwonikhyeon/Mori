import { cleanup, fireEvent, render, screen, within } from '@testing-library/preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { phase } from '../lib/boot'
import { now } from '../lib/clock'
import { resetStore } from '../lib/store'
import { toasts } from '../lib/toast'
import type { Device } from '../lib/types'
import { DeviceCards, mmss } from './SettingsDevices'

const UA = {
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
}

const T0 = 1_800_000_000_000
const MIN = 60_000

interface Call {
  method: string
  path: string
  body: unknown
}

let calls: Call[] = []
let list: Device[] = []
let reply: (c: Call) => Response | undefined = () => undefined

const device = (over: Partial<Device>): Device => ({ id: 'd1', name: 'Mac · Chrome', user_agent: UA.mac, created_ms: T0 - 60 * MIN, last_seen_ms: T0, current: false, ...over })
const here = device({ id: 'me', current: true })
const phone = device({ id: 'ph', name: 'iPhone', user_agent: UA.iphone, last_seen_ms: T0 - 5 * MIN })
const desk = device({ id: 'dk', name: 'Windows · Edge', user_agent: UA.windows, last_seen_ms: T0 - 120 * MIN })

function server(c: Call): Response | undefined {
  if (c.path === '/api/devices') return Response.json(list)
  if (c.method === 'DELETE' && c.path.startsWith('/api/devices/')) {
    list = list.filter((d) => `/api/devices/${d.id}` !== c.path)
    return new Response(null, { status: 204 })
  }
  if (c.path === '/api/logout') return new Response(null, { status: 204 })
  if (c.path === '/api/pair-codes') return Response.json({ code: 'ABCD-EFGH', url: '/pair#code=ABCD-EFGH', expires_ms: T0 + 5 * MIN }, { status: 201 })
  return undefined
}

const toastTexts = () => toasts.value.map((t) => [t.text, t.kind])
const revokeLabels = () => screen.getAllByRole('button', { name: /연결 해제$/ }).map((b) => b.getAttribute('aria-label'))
const heading = () => screen.getByRole('heading', { name: /^기기/ })
// The clock of the code and the poll start with an effect, after the code is shown.
const armed = () => vi.waitFor(() => expect(vi.getTimerCount()).toBe(2))

beforeEach(() => {
  calls = []
  list = [desk, here, phone]
  reply = server
  toasts.value = []
  now.value = T0
  vi.spyOn(Date, 'now').mockReturnValue(T0)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
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
  phase.value = 'loading'
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('mmss', () => {
  it('reads the time left as minutes and seconds, a part second as a whole one', () => {
    expect(mmss(5 * MIN)).toBe('5:00')
    expect(mmss(291_000)).toBe('4:51')
    expect(mmss(59_001)).toBe('1:00')
    expect(mmss(1)).toBe('0:01')
    expect(mmss(0)).toBe('0:00')
    expect(mmss(-3_000)).toBe('0:00')
  })
})

describe('DeviceCards', () => {
  it('lists this device first, then the one seen last', async () => {
    render(<DeviceCards variant="phone" />)
    await screen.findByText('Windows · Edge')
    expect(heading().textContent).toBe('기기 3')
    expect(revokeLabels()).toEqual(['이 기기 연결 해제', 'iPhone 연결 해제', 'Windows · Edge 연결 해제'])
    expect(screen.getByText('이 기기')).toBeTruthy()
    // The browser only where the name does not say it.
    expect(screen.getByText('Safari · 5분 전 접속')).toBeTruthy()
    expect(screen.getByText('2시간 전 접속')).toBeTruthy()
  })

  it('says when the list cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    render(<DeviceCards variant="phone" />)
    expect((await screen.findByRole('alert')).textContent).toBe('서버에 연결할 수 없습니다')
  })

  it('lets another device go after asking, and keeps the focus in the card', async () => {
    render(<DeviceCards variant="pc" />)
    fireEvent.click(await screen.findByRole('button', { name: 'iPhone 연결 해제' }))
    const ask = screen.getByRole('dialog', { name: 'iPhone 연결을 해제할까요?' })
    expect(ask.textContent).toContain('그 기기는 다시 페어링해야 이 호스트를 쓸 수 있습니다.')
    fireEvent.click(within(ask).getByRole('button', { name: '연결 해제' }))
    await vi.waitFor(() => expect(toastTexts()).toEqual([['iPhone 연결을 해제했습니다', 'info']]))
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual(['/api/devices/ph'])
    expect(revokeLabels()).toEqual(['이 기기 연결 해제', 'Windows · Edge 연결 해제'])
    expect(heading().textContent).toBe('기기 2')
    await vi.waitFor(() => expect(document.activeElement).toBe(heading()))
  })

  it('pairs this browser again once it lets itself go', async () => {
    render(<DeviceCards variant="pc" />)
    fireEvent.click(await screen.findByRole('button', { name: '이 기기 연결 해제' }))
    const ask = screen.getByRole('dialog', { name: '이 기기의 연결을 해제할까요?' })
    expect(ask.textContent).toContain('이 브라우저는 다시 페어링해야 이 호스트를 쓸 수 있습니다.')
    fireEvent.click(within(ask).getByRole('button', { name: '연결 해제' }))
    await vi.waitFor(() => expect(phase.value).toBe('pair'))
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/logout')).toBe(true)
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
  })

  it('makes a code for a new device, with its QR, the link and the time left', async () => {
    render(<DeviceCards variant="phone" />)
    await screen.findByText('Windows · Edge')
    expect(screen.getByText('새 기기에서 열 링크와 QR 코드를 만듭니다. 코드는 5분 동안 한 번만 쓸 수 있습니다.')).toBeTruthy()
    const make = screen.getByRole('button', { name: '코드 만들기' })
    make.focus()
    fireEvent.click(make)
    expect(await screen.findByText('ABCD-EFGH')).toBeTruthy()
    expect(calls.find((c) => c.path === '/api/pair-codes')).toEqual({ method: 'POST', path: '/api/pair-codes', body: { name: '' } })
    const link = `${location.origin}/pair#code=ABCD-EFGH`
    expect(screen.getByRole('textbox', { name: '링크' }).textContent).toBe(link)
    const qr = screen.getByRole('img', { name: '페어링 QR 코드' })
    expect(qr.getAttribute('width')).toBe('104')
    expect(screen.getByText('5:00 남음 · 한 번만 쓸 수 있습니다')).toBeTruthy()
    // The same button, so the focus is still on it.
    expect(make.textContent).toBe('새 코드 만들기')
    expect(document.activeElement).toBe(make)
  })

  it('counts down, and says when the code has run out', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    render(<DeviceCards variant="pc" />)
    fireEvent.click(await screen.findByRole('button', { name: '코드 만들기' }))
    await screen.findByText('5:00 남음 · 한 번만 쓸 수 있습니다')
    expect(screen.getByRole('img', { name: '페어링 QR 코드' }).getAttribute('width')).toBe('152')
    await armed()

    vi.mocked(Date.now).mockReturnValue(T0 + 9_500)
    vi.advanceTimersByTime(1_000)
    expect(await screen.findByText('4:51 남음 · 한 번만 쓸 수 있습니다')).toBeTruthy()

    vi.mocked(Date.now).mockReturnValue(T0 + 5 * MIN)
    vi.advanceTimersByTime(1_000)
    expect(await screen.findByText('코드가 만료되었습니다. 새 코드를 만드세요.')).toBeTruthy()
    expect(screen.queryByText('ABCD-EFGH')).toBeNull()
    expect(screen.getByRole('button', { name: '새 코드 만들기' })).toBeTruthy()
  })

  it('sees the new device come while the code waits', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    render(<DeviceCards variant="pc" />)
    fireEvent.click(await screen.findByRole('button', { name: '코드 만들기' }))
    await screen.findByText('ABCD-EFGH')
    await armed()
    const asked = () => calls.filter((c) => c.path === '/api/devices').length
    const before = asked()

    vi.advanceTimersByTime(3_000)
    expect(asked()).toBe(before + 1)
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.getByText('ABCD-EFGH')).toBeTruthy()

    list = [...list, device({ id: 'new', name: 'iPad', user_agent: UA.iphone })]
    vi.advanceTimersByTime(3_000)
    await vi.waitFor(() => expect(toastTexts()).toEqual([['iPad 기기를 연결했습니다', 'info']]))
    expect(screen.queryByText('ABCD-EFGH')).toBeNull()
    expect(heading().textContent).toBe('기기 4')
  })

  it('copies the link', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('isSecureContext', true)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true, writable: true })
    render(<DeviceCards variant="pc" />)
    fireEvent.click(await screen.findByRole('button', { name: '코드 만들기' }))
    fireEvent.click(await screen.findByRole('button', { name: '복사' }))
    await vi.waitFor(() => expect(toastTexts()).toEqual([['링크를 복사했습니다', 'info']]))
    expect(writeText).toHaveBeenCalledWith(`${location.origin}/pair#code=ABCD-EFGH`)
  })
})
