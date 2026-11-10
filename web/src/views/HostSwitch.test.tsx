import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/preact'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { status, term } from '../../test/fixtures'
import { inHost, withHost, withHosts } from '../../test/scopes'
import { hello } from '../lib/boot'
import { now } from '../lib/clock'
import { route } from '../lib/router'
import { conn, core, ready, resetStore, terminals } from '../lib/store'
import { HostButton, HostPicker, HostSheet, OthersBadge } from './HostSwitch'

const LAB_UNLINKED = { id: 'h_lab00001', name: 'lab', url: 'https://lab.example.ts.net', linked: false, version: '0.10.2', relay: false }

beforeEach(() => {
  now.value = 10 * 3_600_000
  hello.value = { app: 'mori', version: '0.1.0', host: 'macmini', paired: true }
  conn.value = 'open'
  core.value = { connected: true }
  ready.value = true
  route.value = { name: 'queue' }
})

afterEach(() => {
  cleanup()
  resetStore()
  hello.value = null
  route.value = { name: 'queue' }
  history.replaceState(null, '', '/#/')
})

describe('HostPicker', () => {
  it('picks another host from the header on a PC', () => {
    terminals.value = new Map([['t1', term({ status: status('blocked', { kind: 'permission' }) })]])
    const [desk] = withHosts({}, LAB_UNLINKED)
    desk.terminals.value = new Map([
      ['d1', term({ address: 'd1', status: status('error', { msg: '중단됨' }) })],
      ['d2', term({ address: 'd2', status: status('idle') })],
    ])
    desk.conn.value = 'open'
    desk.core.value = { connected: true }
    route.value = { name: 'folders' }
    render(<HostPicker />)
    fireEvent.click(screen.getByRole('button', { name: '호스트 macmini · 연결됨' }))
    expect(screen.getAllByRole('menuitemradio').map((e) => [e.textContent, e.getAttribute('aria-checked')])).toEqual([
      ['macmini · 승인 대기 1', 'true'],
      ['desk · 오류 1 · 입력 대기 1', 'false'],
      ['lab · 끊김', 'false'],
    ])
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^desk/ }))
    expect(location.hash).toBe('#/h/h_desk0001/folders')
    fireEvent.click(screen.getByRole('button', { name: /^호스트 macmini/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: '호스트 관리' }))
    expect(location.hash).toBe('#/settings')
  })
})

describe('HostSheet', () => {
  it('opens the host sheet from the phone header and switches there', () => {
    terminals.value = new Map([['t1', term({ status: status('working') })]])
    const [desk] = withHosts({}, LAB_UNLINKED)
    desk.terminals.value = new Map([['d1', term({ address: 'd1', status: status('blocked', { kind: 'permission' }) })]])
    desk.conn.value = 'open'
    desk.core.value = { connected: true }
    render(
      <>
        <HostButton />
        <HostSheet />
      </>,
    )
    const btn = screen.getByRole('button', { name: /^호스트 macmini/ })
    expect(btn.getAttribute('aria-haspopup')).toBe('dialog')
    fireEvent.click(btn)
    const sheet = screen.getByRole('dialog', { name: '호스트' }) as HTMLDialogElement
    expect(within(sheet).getByText('이 폰은 허브 macmini에 페어링했습니다. 다른 호스트도 이 허브를 거쳐 엽니다.')).toBeTruthy()
    const rows = within(within(sheet).getByRole('list', { name: '호스트 목록' })).getAllByRole('button')
    expect(rows.map((r) => r.getAttribute('aria-current'))).toEqual(['true', null, null])
    expect(rows[0].textContent).toContain('이 폰이 페어링한 곳')
    expect(rows[0].textContent).toContain('작업 중 1')
    expect(rows[1].textContent).toContain('연결됨 · v0.1.0')
    expect(rows[1].textContent).toContain('승인 대기 1')
    expect(rows[2].textContent).toContain('새 코드로 다시 연결해야 합니다')
    expect(within(sheet).getByRole('link', { name: '설정에서 호스트 관리' }).getAttribute('href')).toBe('#/settings')
    fireEvent.click(rows[1])
    expect(location.hash).toBe('#/h/h_desk0001')
    expect(sheet.open).toBe(false)
  })
})

describe('OthersBadge', () => {
  it('points at the other host where most waits', () => {
    const [desk, lab] = withHosts({}, { id: 'h_lab00001', name: 'lab', url: 'https://lab.example.ts.net' })
    desk.terminals.value = new Map([['d1', term({ address: 'd1', status: status('idle') })]])
    lab.terminals.value = new Map([['l1', term({ address: 'l1', status: status('blocked', { kind: 'permission' }) })]])
    render(<OthersBadge />)
    expect(screen.getByRole('link', { name: 'lab 승인 대기 1' }).getAttribute('href')).toBe('#/h/h_lab00001')
    act(() => {
      lab.unreachable.value = true
    })
    expect(screen.getByRole('link', { name: 'desk 입력 대기 1' }).getAttribute('href')).toBe('#/h/h_desk0001')
    act(() => {
      desk.terminals.value = new Map()
    })
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('counts the hub when another host is shown', () => {
    terminals.value = new Map([['t1', term({ status: status('blocked', { kind: 'permission' }) })]])
    render(inHost(withHost(), <OthersBadge />))
    expect(screen.getByRole('link', { name: 'macmini 승인 대기 1' }).getAttribute('href')).toBe('#/')
  })
})
