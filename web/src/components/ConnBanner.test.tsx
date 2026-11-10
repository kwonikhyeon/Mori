import { cleanup, fireEvent, render, screen } from '@testing-library/preact'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { inHost, withHost } from '../../test/scopes'
import { ConnBanner } from './ConnBanner'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ConnBanner', () => {
  it('says a host is out of reach and tries again', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (seen.push(url), Response.json({}))))
    const s = withHost()
    s.apply({ type: 'snapshot', core: { connected: true }, folders: [], terminals: [] })
    s.unreachable.value = true
    render(inHost(s, <ConnBanner list />))
    expect(screen.getByRole('status').textContent).toContain('desk에 닿지 못했습니다')
    expect(screen.getByRole('status').textContent).toContain('마지막으로 본 목록입니다')
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }))
    await vi.waitFor(() => expect(seen).toContain('/h/h_desk0001/api/overview'))
  })

  // The page opened while the hub could not reach the host: no list was ever shown.
  it('does not speak of a last list it never had', () => {
    const s = withHost()
    s.unreachable.value = true
    render(inHost(s, <ConnBanner list />))
    const said = screen.getByRole('status').textContent
    expect(said).toContain('desk에 닿지 못했습니다')
    expect(said).toContain('아직 받은 목록이 없습니다')
    expect(said).not.toContain('마지막으로 본 목록입니다')
    expect(screen.getByRole('button', { name: '다시 시도' })).toBeTruthy()
  })

  // A session, Git or the settings: no list of the host is shown there.
  it('speaks of no list above a screen without one', () => {
    const s = withHost()
    s.apply({ type: 'snapshot', core: { connected: true }, folders: [], terminals: [] })
    s.unreachable.value = true
    render(inHost(s, <ConnBanner />))
    const said = screen.getByRole('status').textContent
    expect(said).toContain('desk에 닿지 못했습니다')
    expect(said).toContain('다시 연결하는 중입니다')
    expect(said).not.toContain('목록')
  })
})
