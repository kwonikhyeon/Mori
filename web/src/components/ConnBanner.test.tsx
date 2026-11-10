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
    s.unreachable.value = true
    render(inHost(s, <ConnBanner />))
    expect(screen.getByRole('status').textContent).toContain('desk에 닿지 못했습니다')
    expect(screen.getByRole('status').textContent).toContain('마지막으로 본 목록입니다')
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }))
    await vi.waitFor(() => expect(seen).toContain('/h/h_desk0001/api/overview'))
  })
})
