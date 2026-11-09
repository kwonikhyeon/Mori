import { describe, expect, it } from 'vitest'
import { folder, status, term, worktree } from '../../test/fixtures'
import { appName, branchOf, chip, endText, finishedLine, place, shortHash, shortPath } from './format'
import type { Preset } from './types'

const presets: Preset[] = [
  { id: 'claude', name: 'Claude Code', argv: ['claude'], task: true },
  { id: 'shell', name: '셸', argv: [], task: false },
]

describe('chip', () => {
  it('names each state', () => {
    expect(chip(term({ status: status('blocked') }))).toEqual({ kind: 'blocked', label: '승인 대기' })
    expect(chip(term({ status: status('error') }))).toEqual({ kind: 'error', label: '오류' })
    expect(chip(term({ status: status('idle') }))).toEqual({ kind: 'waiting', label: '입력 대기' })
    expect(chip(term({ status: status('done') }))).toEqual({ kind: 'waiting', label: '입력 대기' })
    expect(chip(term({ status: status('working') }))).toEqual({ kind: 'working', label: '작업 중' })
    expect(chip(term({ status: status('working', { progress: 40 }) }))).toEqual({ kind: 'working', label: '작업 중 40%' })
    expect(chip(term())).toEqual({ kind: 'none', label: '상태 없음' })
    expect(chip(term({ state: 'finished', status: status('working') }))).toEqual({ kind: 'exited', label: '종료' })
  })
})

describe('appName', () => {
  it('takes the preset name, else the program', () => {
    expect(appName(term({ preset: 'claude' }), presets)).toBe('Claude Code')
    expect(appName(term({ preset: 'gone', argv: ['/usr/local/bin/codex', '--x'] }), presets)).toBe('codex')
    expect(appName(term({ preset: undefined, argv: ['C:\\Tools\\aider.exe'] }), presets)).toBe('aider')
    expect(appName(term({ preset: undefined, argv: [] }), presets)).toBe('셸')
  })
})

describe('place', () => {
  const fs = [folder({
    worktrees: [
      worktree(),
      worktree({ path: '/Users/me/dev/Mori.wt/feat-push', branch: 'feat/push-tags', main: false }),
      worktree({ path: '/Users/me/dev/Mori.wt/x', branch: '', detached: true, head: 'ffeeddccbbaa99887766554433221100ffeeddcc', main: false }),
    ],
  }), folder({ id: 'plain', name: 'notes', repo: false, worktrees: [] })]

  it('is the folder and the branch of the worktree', () => {
    expect(place(term(), fs)).toBe('Mori / main')
    expect(place(term({ worktree: '/Users/me/dev/Mori.wt/feat-push' }), fs)).toBe('Mori / feat/push-tags')
    expect(place(term({ worktree: '/Users/me/dev/Mori.wt/x' }), fs)).toBe('Mori / ffeeddc')
    expect(place(term({ folder_id: 'plain', worktree: '' }), fs)).toBe('notes')
  })

  it('is the shortened path outside the folders', () => {
    expect(place(term({ folder_id: '', cwd: '/Users/me/tmp' }), fs)).toBe('~/tmp')
    expect(place(term({ address: 'desktop/t3', folder_id: '', cwd: 'C:\\Users\\me\\work' }), fs)).toBe('desktop · ~\\work')
  })
})

describe('branchOf', () => {
  const f = folder({
    worktrees: [worktree(), worktree({ path: '/w/x', branch: '', detached: true, head: 'ffeeddccbbaa99887766554433221100ffeeddcc', main: false })],
  })
  it('is the branch of the worktree, its hash when detached, else nothing', () => {
    expect(branchOf(term(), f)).toBe('main')
    expect(branchOf(term({ worktree: '/w/x' }), f)).toBe('ffeeddc')
    expect(branchOf(term({ worktree: '/elsewhere' }), f)).toBe('')
  })
})

describe('shortPath', () => {
  it('writes the home folder as ~', () => {
    expect(shortPath('/Users/ikhyeon/dev/proj')).toBe('~/dev/proj')
    expect(shortPath('/Users/ikhyeon')).toBe('~')
    expect(shortPath('/home/me/x')).toBe('~/x')
    expect(shortPath('C:\\Users\\me\\dev')).toBe('~\\dev')
    expect(shortPath('/opt/x')).toBe('/opt/x')
    expect(shortPath('/Users/Shared/x')).toBe('/Users/Shared/x')
  })
})

describe('endText', () => {
  it('says why a program ended', () => {
    expect(endText({ reason: 'exited', exit_code: 0, signal: null })).toBe('코드 0')
    expect(endText({ reason: 'exited', exit_code: 130, signal: null })).toBe('코드 130')
    expect(endText({ reason: 'signaled', exit_code: null, signal: 9 })).toBe('신호 9')
    expect(endText({ reason: 'killed', exit_code: null, signal: null })).toBe('강제 종료')
    expect(endText({ reason: 'host_shutdown', exit_code: null, signal: null })).toBe('컴퓨터 종료')
    expect(endText({ reason: 'something-new', exit_code: null, signal: null })).toBe('끝남')
    expect(endText({ reason: null, exit_code: 2, signal: null })).toBe('코드 2')
  })

  it('writes the line of a recently finished session', () => {
    const now = 1_800_000_000_000
    const t = term({ preset: 'shell', argv: [], state: 'finished', reason: 'exited', exit_code: 0, finished_ms: now - 2 * 3_600_000 })
    expect(finishedLine(t, presets, now)).toBe('셸 · 코드 0 · 2시간 전')
  })
})

describe('shortHash', () => {
  it('keeps seven characters', () => {
    expect(shortHash('a1b2c3d4e5f6')).toBe('a1b2c3d')
  })
})
