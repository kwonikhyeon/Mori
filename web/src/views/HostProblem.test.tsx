import { cleanup, fireEvent, render, screen } from '@testing-library/preact'
import { afterEach, describe, expect, it } from 'vitest'
import { inHost, withHost } from '../../test/scopes'
import { route } from '../lib/router'
import { HostProblem } from './HostProblem'
import { hostSheet } from './HostSwitch'
import { relinkHost } from './SettingsHosts'

afterEach(() => {
  cleanup()
  history.replaceState(null, '', '/#/')
  route.value = { name: 'queue' }
  relinkHost.value = ''
  hostSheet.value = false
})

describe('HostProblem', () => {
  it('says the host was unlinked and offers a new code', () => {
    const s = withHost({ linked: false, version: '', relay: false })
    render(inHost(s, <HostProblem variant="phone" />))
    expect(screen.getByRole('heading', { name: 'desk 연결이 끊겼습니다' })).toBeTruthy()
    expect(screen.getByText('그 호스트가 이 허브의 연결을 해제했거나 아직 잇지 않았습니다. 그 호스트에서 mori pair로 새 코드를 받아 다시 연결하세요.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '다른 호스트 보기' }))
    expect(hostSheet.value).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '새 코드로 다시 연결' }))
    expect(relinkHost.value).toBe('https://desk.example.ts.net')
    expect(location.hash).toBe('#/settings')
  })

  it('leaves picking another host to the header on a PC', () => {
    render(inHost(withHost({ linked: false, version: '', relay: false }), <HostProblem variant="pc" />))
    expect(screen.queryByRole('button', { name: '다른 호스트 보기' })).toBeNull()
  })
})
