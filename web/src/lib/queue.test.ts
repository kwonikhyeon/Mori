import { describe, expect, it } from 'vitest'
import { folder, status, term } from '../../test/fixtures'
import { groupByFolder, groupQueue, needsCount, sessionsByWorktree } from './queue'

const NOW = 1_800_000_000_000
const H = 3_600_000

describe('groupQueue', () => {
  it('puts the sessions that need a hand first', () => {
    const groups = groupQueue([
      term({ address: 'w', status: status('working') }),
      term({ address: 'i', status: status('idle') }),
      term({ address: 'b', status: status('blocked') }),
      term({ address: 'd', status: status('done') }),
      term({ address: 'e', status: status('error') }),
      term({ address: 'n' }),
      term({ address: 'x', status: status('something-new') }),
    ])
    expect(groups.map((g) => [g.key, g.title, g.items.map((t) => t.address), g.collapsed])).toEqual([
      ['blocked', '승인 대기', ['b'], false],
      ['error', '오류', ['e'], false],
      ['waiting', '입력 대기', ['i', 'd'], false],
      ['working', '작업 중', ['w'], false],
      ['none', '상태 없음', ['n', 'x'], true],
    ])
  })

  it('puts the latest change on top, by status time or else start time', () => {
    const [blocked] = groupQueue([
      term({ address: 'old', status: status('blocked'), status_ms: NOW - 3 * H, created_ms: NOW - 9 * H }),
      term({ address: 'new', status: status('blocked'), status_ms: NOW - H }),
      term({ address: 'nostatusms', status: status('blocked'), status_ms: null, created_ms: NOW - 2 * H }),
    ])
    expect(blocked.items.map((t) => t.address)).toEqual(['new', 'nostatusms', 'old'])
  })

  // a finished session is in no group, however recent (spec §3 #229)
  it('leaves finished sessions out', () => {
    const groups = groupQueue([
      term({ address: 'a', state: 'finished', finished_ms: NOW - H, status: status('done') }),
      term({ address: 'b', state: 'finished', finished_ms: NOW }),
    ])
    expect(groups.flatMap((g) => g.items)).toEqual([])
  })

  it('counts approvals, errors and waiting input for the badge', () => {
    const groups = groupQueue([
      term({ address: 'b', status: status('blocked') }),
      term({ address: 'e', status: status('error') }),
      term({ address: 'i', status: status('idle') }),
      term({ address: 'd', status: status('done') }),
      term({ address: 'w', status: status('working') }),
      term({ address: 'n' }),
      term({ address: 'f', state: 'finished', finished_ms: NOW }),
    ])
    expect(needsCount(groups)).toBe(4)
  })
})

describe('groupByFolder', () => {
  it('follows the folder order, puts the rest under 기타 and leaves finished sessions out', () => {
    const fs = [folder({ id: 'f1', name: 'Mori' }), folder({ id: 'f2', name: 'TopoMind' }), folder({ id: 'f3', name: 'Empty' })]
    const groups = groupByFolder([
      term({ address: 'a', folder_id: 'f2', created_ms: 1 }),
      term({ address: 'b', folder_id: 'f1', created_ms: 1 }),
      term({ address: 'c', folder_id: 'f2', created_ms: 5 }),
      term({ address: 'machine/t7', folder_id: '' }),
      term({ address: 'gone', folder_id: 'f9' }),
      term({ address: 'fin', folder_id: 'f2', state: 'finished', created_ms: 9, finished_ms: 10 }),
    ], fs)
    expect(groups.map((g) => [g.folder?.name ?? '기타', g.items.map((t) => t.address)])).toEqual([
      ['Mori', ['b']],
      ['TopoMind', ['c', 'a']],
      ['Empty', []],
      ['기타', ['machine/t7', 'gone']],
    ])
  })

  it('has no 기타 when every session has a folder', () => {
    const groups = groupByFolder([term()], [folder()])
    expect(groups).toHaveLength(1)
  })
})

describe('sessionsByWorktree', () => {
  it('counts the running sessions of a folder by worktree', () => {
    const n = sessionsByWorktree([
      term({ address: 'a', worktree: '/r' }),
      term({ address: 'b', worktree: '/r' }),
      term({ address: 'c', worktree: '/r.wt/x' }),
      term({ address: 'fin', worktree: '/r.wt/x', state: 'finished' }),
      term({ address: 'other', worktree: '/r', folder_id: 'f2' }),
    ], 'f1')
    expect([...n]).toEqual([['/r', 2], ['/r.wt/x', 1]])
  })
})
