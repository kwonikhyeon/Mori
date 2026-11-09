import { describe, expect, it } from 'vitest'
import { connBanner, hostState } from './health'

describe('connBanner', () => {
  it('says nothing while all is well or in the first seconds', () => {
    expect(connBanner('open', { connected: true })).toBeNull()
    expect(connBanner('connecting', { connected: false })).toBeNull()
  })

  it('names what is wrong', () => {
    expect(connBanner('down', { connected: true })?.title).toBe('서버에 다시 연결하는 중')
    expect(connBanner('restarting', { connected: true })?.title).toBe('서버 재시작 중')
    expect(connBanner('open', { connected: false })?.title).toBe('코어 연결 중')
  })

  it('tells a missing hc apart from a core that is coming', () => {
    const b = connBanner('open', { connected: false, error: 'hc not found: install herdr-core or pass --hc' })
    expect(b).toMatchObject({ kind: 'error', title: 'herdr-core가 설치되지 않음' })
  })
})

describe('hostState', () => {
  it('follows the stream and the core', () => {
    expect(hostState('open', { connected: true })).toEqual({ dot: 'ok', text: '연결됨' })
    expect(hostState('open', { connected: false })).toEqual({ dot: 'warn', text: '코어 연결 중' })
    expect(hostState('connecting', { connected: false })).toEqual({ dot: 'off', text: '연결 중' })
    expect(hostState('restarting', { connected: true })).toEqual({ dot: 'warn', text: '재시작 중' })
    expect(hostState('down', { connected: true })).toEqual({ dot: 'bad', text: '연결 끊김' })
  })
})
