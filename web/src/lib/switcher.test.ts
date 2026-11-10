import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { folder, status, term } from '../../test/fixtures'
import { withHosts } from '../../test/scopes'
import { hello } from './boot'
import { now } from './clock'
import { route } from './router'
import { hub, type HostScope } from './scope'
import { folders, ready, resetStore, terminals } from './store'
import { blockedOf, entriesOf, filterEntries, isAt, spotOf, stepBlocked, stepFrom } from './switcher'
import { toasts } from './toast'
import type { TerminalView } from './types'

const NOW = 10 * 3_600_000

const map = (...ts: TerminalView[]) => new Map(ts.map((t) => [t.address, t]))

beforeEach(() => {
  now.value = NOW
  hello.value = { app: 'mori', version: '0.1.0', host: 'macmini', paired: true }
  ready.value = true
  route.value = { name: 'queue' }
})

afterEach(() => {
  resetStore()
  hello.value = null
  toasts.value = []
  route.value = { name: 'queue' }
  history.replaceState(null, '', '/#/')
})

/** desk, linked and reached. */
function desk(...ts: TerminalView[]): HostScope {
  const [d] = withHosts({})
  d.terminals.value = map(...ts)
  d.ready.value = true
  return d
}

describe('entriesOf', () => {
  it('puts the groups in the queue order, each host by host, and names the host when there are more', () => {
    folders.value = [folder()]
    terminals.value = map(
      term({ address: 't1', display_title: '빌드 고치기', status: status('working'), status_ms: NOW - 5 }),
      term({ address: 't2', display_title: '', status: status('blocked', { kind: 'permission' }), status_ms: NOW - 9 }),
    )
    const d = desk(
      term({ address: 'd1', display_title: '배포', status: status('blocked', { kind: 'question' }), status_ms: NOW - 1, folder_id: '' }),
      term({ address: 'd2', display_title: '정리', state: 'finished', finished_ms: NOW - 60_000 }),
      term({ address: 'd3', display_title: '옛것', state: 'finished', finished_ms: NOW - 48 * 3_600_000 }),
    )
    const es = entriesOf([hub, d], NOW)
    expect(es.map((e) => [e.s.id, e.t.address, e.group, e.title])).toEqual([
      ['', 't2', 'blocked', 'claude'],
      ['h_desk0001', 'd1', 'blocked', '배포'],
      ['', 't1', 'working', '빌드 고치기'],
      ['h_desk0001', 'd2', 'finished', '정리'],
    ])
    expect(es[0].sub).toBe('claude · Mori / main · macmini')
    expect(es[1].sub).toBe('claude · ~/dev/Mori · desk')
    expect(es[1].hay).toContain('승인 대기')
  })

  it('leaves the host out of the line with one host, and skips a host it cannot show', () => {
    terminals.value = map(term({ address: 't1', status: status('idle') }))
    expect(entriesOf([hub], NOW).map((e) => e.sub)).toEqual(['claude · ~/dev/Mori'])
    const d = desk(term({ address: 'd1' }))
    d.unreachable.value = true
    expect(entriesOf([hub, d], NOW).map((e) => e.t.address)).toEqual(['t1'])
    d.unreachable.value = false
    d.ready.value = false
    expect(entriesOf([hub, d], NOW).map((e) => e.t.address)).toEqual(['t1'])
  })
})

describe('filterEntries', () => {
  it('keeps the entries with every word, those whose title starts with the query first', () => {
    terminals.value = map(
      term({ address: 'a', display_title: '문서 빌드', status: status('working'), status_ms: 3 }),
      term({ address: 'b', display_title: '빌드 고치기', status: status('working'), status_ms: 2 }),
      term({ address: 'c', display_title: '정리', cwd: '/Users/me/dev/빌드', status: status('working'), status_ms: 1 }),
      term({ address: 'd', display_title: '배포', status: status('working'), status_ms: 0 }),
    )
    const es = entriesOf([hub], NOW)
    expect(filterEntries(es, '').map((e) => e.t.address)).toEqual(['a', 'b', 'c', 'd'])
    expect(filterEntries(es, '빌드').map((e) => e.t.address)).toEqual(['b', 'a', 'c'])
    expect(filterEntries(es, '  CLAUDE   정리 ').map((e) => e.t.address)).toEqual(['c'])
    expect(filterEntries(es, '작업 중').map((e) => e.t.address)).toEqual(['a', 'b', 'c', 'd'])
    expect(filterEntries(es, '없는것')).toEqual([])
  })
})

describe('stepFrom', () => {
  it('goes round the list from the session on the screen', () => {
    terminals.value = map(
      term({ address: 't1', status: status('blocked'), status_ms: 3 }),
      term({ address: 't2', status: status('blocked'), status_ms: 2 }),
    )
    const d = desk(term({ address: 'd1', status: status('blocked') }), term({ address: 'd2', status: status('working') }))
    const list = blockedOf([hub, d], NOW)
    expect(list.map((f) => f.t.address)).toEqual(['t1', 't2', 'd1'])
    const at = (host: string, addr: string) => ({ host, addr })
    expect(stepFrom(list, at('', 't2'), 1)?.t.address).toBe('d1')
    expect(stepFrom(list, at('h_desk0001', 'd1'), 1)?.t.address).toBe('t1')
    expect(stepFrom(list, at('', 't1'), -1)?.t.address).toBe('d1')
    // Not one of them: the first, or the last.
    expect(stepFrom(list, at('h_desk0001', 'd2'), 1)?.t.address).toBe('t1')
    expect(stepFrom(list, null, -1)?.t.address).toBe('d1')
    // The same address on another host is another session.
    expect(stepFrom(list, at('h_desk0001', 't1'), 1)?.t.address).toBe('t1')
    expect(stepFrom(list.slice(0, 1), at('', 't1'), 1)).toBeNull()
    expect(stepFrom([], null, 1)).toBeNull()
  })

  it('knows the session a route shows', () => {
    expect(spotOf({ name: 'terminal', addr: 'd1', git: false, host: 'h_desk0001' })).toEqual({ host: 'h_desk0001', addr: 'd1' })
    expect(spotOf({ name: 'terminal', addr: 't1', git: true })).toEqual({ host: '', addr: 't1' })
    expect(spotOf({ name: 'queue' })).toBeNull()
    expect(isAt({ s: hub, t: term() }, null)).toBe(false)
  })
})

describe('stepBlocked', () => {
  it('opens the next session that waits, keeping the Git panel, and says when none other waits', () => {
    terminals.value = map(term({ address: 't1', status: status('blocked') }))
    desk(term({ address: 'd1', status: status('blocked') }))
    stepBlocked(1)
    expect(location.hash).toBe('#/t/t1')
    expect(route.value).toEqual({ name: 'terminal', addr: 't1', git: false })
    route.value = { name: 'terminal', addr: 't1', git: true }
    stepBlocked(1)
    expect(location.hash).toBe('#/h/h_desk0001/t/d1/git')
    expect(toasts.value).toEqual([])
  })

  it('says so when no session waits, or only the one on the screen', () => {
    terminals.value = map(term({ address: 't1', status: status('working') }))
    stepBlocked(1)
    expect(toasts.value.map((t) => t.text)).toEqual(['승인 대기 세션이 없습니다'])
    terminals.value = map(term({ address: 't1', status: status('blocked') }))
    route.value = { name: 'terminal', addr: 't1', git: false }
    stepBlocked(-1)
    expect(toasts.value.map((t) => t.text)).toEqual(['승인 대기 세션이 없습니다', '다른 승인 대기 세션이 없습니다'])
    expect(route.value).toEqual({ name: 'terminal', addr: 't1', git: false })
  })
})
