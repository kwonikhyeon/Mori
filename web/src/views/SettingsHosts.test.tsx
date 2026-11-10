import { cleanup, fireEvent, render, screen, within } from '@testing-library/preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { linkedHost } from '../../test/fixtures'
import { hello } from '../lib/boot'
import { hosts, resetStore } from '../lib/store'
import { toasts } from '../lib/toast'
import { HostsCard, LinkHostCard, relinkHost } from './SettingsHosts'

type Call = { method: string; url: string; body: unknown }
let calls: Call[]
let reply: (c: Call) => Response | undefined
const toastTexts = () => toasts.value.map((t) => [t.text, t.kind])
const field = (name: string) => screen.getByRole('textbox', { name }) as HTMLInputElement
const nameHint = () => document.getElementById(field('이름').getAttribute('aria-describedby')!)!.textContent
const LAB = linkedHost({ id: 'h_lab00001', name: 'lab', url: 'https://lab.example.ts.net', relay: false, relay_error: 'push service said 410' })
const UNLINKED = linkedHost({ linked: false, version: '', relay: false })

beforeEach(() => {
  calls = []
  reply = () => undefined
  hello.value = { app: 'mori', version: '0.1.0', host: 'macmini', paired: true }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const c = { method: init.method ?? 'GET', url, body: init.body ? JSON.parse(String(init.body)) : undefined }
    calls.push(c)
    const r = reply(c)
    if (r) return r
    return c.method === 'GET' && url === '/api/hosts' ? Response.json(hosts.value) : new Response(null, { status: 204 })
  }))
})

afterEach(() => {
  cleanup()
  resetStore()
  hello.value = null
  toasts.value = []
  relinkHost.value = ''
  vi.unstubAllGlobals()
})

describe('HostsCard', () => {
  it('lists the hub first and then each linked host', () => {
    hosts.value = [linkedHost(), LAB]
    render(<HostsCard />)
    expect(screen.getByRole('heading', { name: '연결한 호스트 3곳' })).toBeTruthy()
    const rows = screen.getAllByRole('listitem')
    expect(rows.map((r) => r.querySelector('.st-name')!.textContent)).toEqual(['macmini', 'desk', 'lab'])
    expect(within(rows[0]).getByText('이 호스트')).toBeTruthy()
    expect(within(rows[0]).getByText('허브')).toBeTruthy()
    expect(within(rows[1]).getByText('desk.example.ts.net')).toBeTruthy()
    expect(within(rows[1]).getByText('연결됨 · 알림 켬 · v0.1.0')).toBeTruthy()
    expect(within(rows[2]).getByText('연결됨 · 알림 꺼짐 · v0.1.0')).toBeTruthy()
    expect(within(rows[2]).getByText('알림 중계를 켜지 못했습니다 — 이 호스트의 승인 대기 알림이 폰에 오지 않습니다')).toBeTruthy()
    expect(within(rows[2]).getByText('push service said 410')).toBeTruthy()
  })

  it('relinks the relay and says so', async () => {
    hosts.value = [LAB]
    reply = (c) => (c.url === '/api/hosts/h_lab00001/relay' ? Response.json({ ...LAB, relay: true, relay_error: undefined }) : undefined)
    render(<HostsCard />)
    fireEvent.click(screen.getByRole('button', { name: '알림 다시 연결' }))
    await vi.waitFor(() => expect(toastTexts()).toEqual([['알림을 다시 이었습니다: lab', 'info']]))
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['POST /api/hosts/h_lab00001/relay', 'GET /api/hosts'])
  })

  it('renames a host in place', async () => {
    hosts.value = [linkedHost()]
    reply = (c) => (c.method === 'PATCH' ? Response.json(linkedHost({ name: '책상' })) : undefined)
    render(<HostsCard />)
    fireEvent.click(screen.getByRole('button', { name: 'desk 이름 바꾸기' }))
    expect(field('이름').maxLength).toBe(100)
    fireEvent.input(field('이름'), { target: { value: '  ' } })
    expect((screen.getByRole('button', { name: '저장' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.input(field('이름'), { target: { value: '책상' } })
    fireEvent.click(screen.getByRole('button', { name: '저장' }))
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'GET')).toBe(true))
    expect(calls[0]).toEqual({ method: 'PATCH', url: '/api/hosts/h_desk0001', body: { name: '책상' } })
  })

  it('unlinks a host after asking', async () => {
    hosts.value = [linkedHost()]
    render(<HostsCard />)
    fireEvent.click(screen.getByRole('button', { name: 'desk 연결 해제' }))
    const ask = screen.getByRole('dialog', { name: 'desk 연결을 해제할까요?' })
    fireEvent.click(within(ask).getByRole('button', { name: '연결 해제' }))
    await vi.waitFor(() => expect(toastTexts()).toEqual([['연결을 해제했습니다: desk', 'info']]))
    expect(calls[0]).toMatchObject({ method: 'DELETE', url: '/api/hosts/h_desk0001' })
  })

  it('offers a new code for a host that is unlinked', () => {
    hosts.value = [UNLINKED]
    render(
      <>
        <HostsCard />
        <LinkHostCard />
      </>,
    )
    expect(screen.getByText('그 호스트가 이 허브의 연결을 해제했거나 아직 잇지 않았습니다')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '새 코드로 다시 연결' }))
    expect(field('페어링 링크 또는 주소').value).toBe('https://desk.example.ts.net')
    expect(document.activeElement).toBe(field('코드'))
  })

  it('only removes an old entry for the hub itself', () => {
    hosts.value = [linkedHost({ id: 'h_self0001', name: 'self', url: location.origin })]
    render(<HostsCard />)
    expect(screen.getByRole('heading', { name: '연결한 호스트 1곳' })).toBeTruthy()
    const row = screen.getByText('self', { selector: '.st-name' }).closest('li') as HTMLElement
    expect(within(row).getByText('이 허브 자신을 가리키는 옛 항목입니다')).toBeTruthy()
    expect(within(row).getAllByRole('button').map((b) => b.textContent)).toEqual(['연결 해제'])
  })
})

describe('LinkHostCard', () => {
  it('links a host from a pasted pairing link', async () => {
    reply = (c) => (c.method === 'POST' ? Response.json(linkedHost(), { status: 201 }) : undefined)
    render(<LinkHostCard />)
    const link = screen.getByRole('button', { name: '연결' }) as HTMLButtonElement
    expect(link.disabled).toBe(true)
    fireEvent.input(field('페어링 링크 또는 주소'), { target: { value: 'https://desk.example.ts.net/pair#code=ABCD-EFGH' } })
    fireEvent.click(link)
    await vi.waitFor(() => expect(toastTexts()).toEqual([['호스트를 이었습니다: desk', 'info']]))
    expect(calls[0]).toEqual({ method: 'POST', url: '/api/hosts', body: { url: 'https://desk.example.ts.net/pair#code=ABCD-EFGH', code: '', name: '' } })
    expect(calls[1]).toMatchObject({ method: 'GET', url: '/api/hosts' })
    expect(field('페어링 링크 또는 주소').value).toBe('')
  })

  it('says it linked again when the host was already there', async () => {
    hosts.value = [UNLINKED]
    reply = (c) => (c.method === 'POST' ? Response.json(linkedHost()) : undefined)
    render(<LinkHostCard />)
    fireEvent.input(field('페어링 링크 또는 주소'), { target: { value: 'https://desk.example.ts.net' } })
    fireEvent.input(field('코드'), { target: { value: 'ABCD-EFGH' } })
    fireEvent.click(screen.getByRole('button', { name: '연결' }))
    await vi.waitFor(() => expect(toastTexts()).toEqual([['다시 이었습니다: desk', 'info']]))
  })

  // The hub keeps the name of a host it had unless another is given (spec §6.9).
  it('says a host linked before keeps its name', () => {
    hosts.value = [UNLINKED, LAB]
    render(<LinkHostCard />)
    fireEvent.input(field('페어링 링크 또는 주소'), { target: { value: 'https://Desk.example.ts.net:443/pair#code=ABCD-EFGH' } })
    expect(nameHint()).toBe('비우면 지금 이름을 그대로 씁니다: desk')
  })

  it("says a new host gives its own name", () => {
    hosts.value = [UNLINKED, LAB]
    render(<LinkHostCard />)
    expect(nameHint()).toBe('비우면 그 호스트의 이름을 씁니다.')
    fireEvent.input(field('페어링 링크 또는 주소'), { target: { value: 'https://macmini.example.ts.net/pair#code=ABCD-EFGH' } })
    expect(nameHint()).toBe('비우면 그 호스트의 이름을 씁니다.')
  })

  it('shows why a link failed', async () => {
    reply = (c) => (c.method === 'POST' ? Response.json({ error: { kind: 'bad_request', message: '코드가 맞지 않습니다' } }, { status: 400 }) : undefined)
    render(<LinkHostCard />)
    fireEvent.input(field('페어링 링크 또는 주소'), { target: { value: 'https://desk.example.ts.net' } })
    fireEvent.input(field('코드'), { target: { value: 'WRONG-CODE' } })
    fireEvent.click(screen.getByRole('button', { name: '연결' }))
    expect((await screen.findByRole('alert')).textContent).toBe('코드가 맞지 않습니다')
    expect(field('페어링 링크 또는 주소').value).toBe('https://desk.example.ts.net')
  })
})
