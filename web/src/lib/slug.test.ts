import { describe, expect, it } from 'vitest'
import { worktree } from '../../test/fixtures'
import type { Branch, Branches } from './types'
import { branchProblem, branchSlug, planOf, worktreePath, worktreeRequest } from './slug'

describe('branchSlug', () => {
  // The table of internal/gitx TestBranchSlugAndPath: the preview and the
  // server must name the same directory.
  it.each([
    ['feat/login', 'feat-login'],
    ['fix//a b', 'fix-a-b'],
    ['-x-', 'x'],
    ['한글', 'wt'],
    ['..', 'wt'],
    ['v1.2', 'v1.2'],
    ['aux', 'wt-aux'],
    ['CON.txt', 'wt-CON.txt'],
    ['com7', 'wt-com7'],
    ['console', 'console'],
    ['fix/알림-중복', 'fix'],
    ['ui/candidates', 'ui-candidates'],
    ['', 'wt'],
  ])('%j → %j', (branch, want) => {
    expect(branchSlug(branch)).toBe(want)
  })

  it('cuts a long name to 64 before it trims the ends', () => {
    expect(branchSlug('a'.repeat(200))).toBe('a'.repeat(64))
    expect(branchSlug('a'.repeat(63) + '/b')).toBe('a'.repeat(63))
  })
})

describe('worktreePath', () => {
  it('goes beside the main worktree', () => {
    expect(worktreePath('/Users/me/dev/Mori', 'fix/notify-dup')).toBe('/Users/me/dev/Mori.wt/fix-notify-dup')
    expect(worktreePath('/Users/me/dev/Mori/', 'a')).toBe('/Users/me/dev/Mori.wt/a')
    expect(worktreePath('/app', 'a')).toBe('/app.wt/a')
  })

  it('writes a Windows path with its own separator', () => {
    expect(worktreePath('C:\\Users\\me\\dev\\Mori', 'feat/x')).toBe('C:\\Users\\me\\dev\\Mori.wt\\feat-x')
    expect(worktreePath('C:\\app', 'x')).toBe('C:\\app.wt\\x')
    expect(worktreePath('\\\\srv\\share\\app', 'x')).toBe('\\\\srv\\share\\app.wt\\x')
  })

  it('takes the next number when a worktree is there already', () => {
    const taken = ['/r/app.wt/feat-a', '/r/app.wt/feat-a-2']
    expect(worktreePath('/r/app', 'feat/a', taken)).toBe('/r/app.wt/feat-a-3')
    expect(worktreePath('C:\\r\\app', 'feat/a', ['c:\\R\\APP.wt\\FEAT-A'])).toBe('C:\\r\\app.wt\\feat-a-2')
    expect(worktreePath('/r/app', 'feat/a', ['/r/app.wt/FEAT-A'])).toBe('/r/app.wt/feat-a')
  })
})

describe('branchProblem', () => {
  // What git 2.54 check-ref-format --branch says of each.
  it.each(['fix/login', 'feature/알림', 'v1.2', 'a.b/c', 'x@y', '@', '@a', 'x{y}', 'head', 'HEADS', 'a.lockx', 'a]b', 'a!b', 'a#b', 'a|b', 'a\u3000b'])(
    'takes %j',
    (name) => {
      expect(branchProblem(name)).toBeNull()
    },
  )

  it.each([
    ['-x', '브랜치 이름은 ‘-’로 시작할 수 없습니다'],
    ['HEAD', '‘HEAD’는 브랜치 이름으로 쓸 수 없습니다'],
    ['smoke/new wt', '브랜치 이름에 공백은 쓸 수 없습니다'],
    ['a\tb', '브랜치 이름에 공백은 쓸 수 없습니다'],
    ['a\x01b', '브랜치 이름에 제어 문자는 쓸 수 없습니다'],
    ['a\x7fb', '브랜치 이름에 제어 문자는 쓸 수 없습니다'],
    ['a~b', '브랜치 이름에 ‘~’ 문자는 쓸 수 없습니다'],
    ['a^b', '브랜치 이름에 ‘^’ 문자는 쓸 수 없습니다'],
    ['a:b', '브랜치 이름에 ‘:’ 문자는 쓸 수 없습니다'],
    ['a?b', '브랜치 이름에 ‘?’ 문자는 쓸 수 없습니다'],
    ['a*b', '브랜치 이름에 ‘*’ 문자는 쓸 수 없습니다'],
    ['a[b', '브랜치 이름에 ‘[’ 문자는 쓸 수 없습니다'],
    ['a\\b', '브랜치 이름에 ‘\\’ 문자는 쓸 수 없습니다'],
    ['a..b', '브랜치 이름에 연속된 점(..)은 쓸 수 없습니다'],
    ['a/../b', '브랜치 이름에 연속된 점(..)은 쓸 수 없습니다'],
    ['..', '브랜치 이름에 연속된 점(..)은 쓸 수 없습니다'],
    ['a@{b', '브랜치 이름에 ‘@{’는 쓸 수 없습니다'],
    ['@{-1}', '브랜치 이름에 ‘@{’는 쓸 수 없습니다'],
    ['/a', '브랜치 이름은 ‘/’로 시작하거나 끝날 수 없습니다'],
    ['fix/', '브랜치 이름은 ‘/’로 시작하거나 끝날 수 없습니다'],
    ['a//b', '브랜치 이름에 ‘//’는 쓸 수 없습니다'],
    ['.a', '브랜치 이름은 ‘.’으로 시작할 수 없습니다'],
    ['.', '브랜치 이름은 ‘.’으로 시작할 수 없습니다'],
    ['a/.b', '‘/’ 다음에 ‘.’이 올 수 없습니다'],
    ['a/./b', '‘/’ 다음에 ‘.’이 올 수 없습니다'],
    ['a.lock', '브랜치 이름은 ‘.lock’으로 끝날 수 없습니다'],
    ['a/b.lock/c', '‘.lock’ 다음에 ‘/’가 올 수 없습니다'],
    ['a.', '브랜치 이름은 ‘.’으로 끝날 수 없습니다'],
  ])('refuses %j', (name, why) => {
    expect(branchProblem(name)).toBe(why)
  })
})

describe('planOf', () => {
  const MAIN = '/r/app'
  const ws = [
    worktree({ path: MAIN, branch: 'main' }),
    worktree({ path: '/r/app.wt/feat-a', branch: 'feat/a', main: false }),
    worktree({ path: '/r/app.wt/x', branch: 'x', main: false, prunable: true }),
    worktree({ path: '/r/app.wt/d', branch: '', detached: true, main: false }),
  ]
  const br = (name: string, remote = false): Branch => ({ name, head: 'h', current: false, remote })
  const b: Branches = { local: [br('main'), br('feat/a'), br('old'), br('ui/candidates')], remote: [br('origin/main', true), br('origin/pr-7', true)] }

  it('says what a name does', () => {
    expect(planOf('', ws, MAIN, b)).toEqual({ kind: 'empty' })
    expect(planOf('a b', ws, MAIN, b)).toEqual({ kind: 'bad', why: '브랜치 이름에 공백은 쓸 수 없습니다' })
    expect(planOf('feat/a', ws, MAIN, b)).toEqual({ kind: 'taken', path: '/r/app.wt/feat-a' })
    expect(planOf('old', ws, MAIN, b)).toEqual({ kind: 'local', path: '/r/app.wt/old' })
    expect(planOf('pr-7', ws, MAIN, b)).toEqual({ kind: 'remote', path: '/r/app.wt/pr-7', remote: 'origin/pr-7' })
    expect(planOf('fix/b', ws, MAIN, b)).toEqual({ kind: 'new', path: '/r/app.wt/fix-b' })
  })

  it('refuses a name beside a branch that is its directory or in it', () => {
    expect(planOf('old/x', ws, MAIN, b)).toEqual({ kind: 'bad', why: '‘old’ 브랜치가 있어서 이 이름은 쓸 수 없습니다' })
    expect(planOf('ui', ws, MAIN, b)).toEqual({ kind: 'bad', why: '‘ui/candidates’ 브랜치가 있어서 이 이름은 쓸 수 없습니다' })
    expect(planOf('uix', ws, MAIN, b).kind).toBe('new')
  })

  it('goes past the worktrees there are, but not one whose folder is gone', () => {
    // feat-a is the directory feat/a has already.
    expect(planOf('feat-a', ws, MAIN, b)).toEqual({ kind: 'new', path: '/r/app.wt/feat-a-2' })
    expect(planOf('x2', [...ws, worktree({ path: '/r/app.wt/x2', branch: '', detached: true, main: false })], MAIN, b)).toEqual({ kind: 'new', path: '/r/app.wt/x2-2' })
    // x's folder is gone, but git keeps its branch until a prune.
    expect(planOf('x', ws, MAIN, b)).toEqual({ kind: 'taken', path: '/r/app.wt/x' })
    expect(planOf('y', ws, MAIN, b)).toEqual({ kind: 'new', path: '/r/app.wt/y' })
  })

  it('takes any name git does while the branches are not known', () => {
    expect(planOf('old/x', ws, MAIN, null)).toEqual({ kind: 'new', path: '/r/app.wt/old-x' })
    expect(planOf('pr-7', ws, MAIN, null).kind).toBe('new')
  })
})

describe('worktreeRequest', () => {
  it('asks for a new branch from its base, or for one there is', () => {
    expect(worktreeRequest({ kind: 'new', path: '/p' }, 'fix/b', 'main')).toEqual({ branch: 'fix/b', create: true, base: 'main' })
    expect(worktreeRequest({ kind: 'new', path: '/p' }, 'fix/b', '')).toEqual({ branch: 'fix/b', create: true })
    expect(worktreeRequest({ kind: 'local', path: '/p' }, 'old', 'main')).toEqual({ branch: 'old', create: false })
    expect(worktreeRequest({ kind: 'remote', path: '/p', remote: 'origin/pr-7' }, 'pr-7', 'main')).toEqual({ branch: 'pr-7', create: false })
    for (const p of [{ kind: 'empty' }, { kind: 'bad', why: 'x' }, { kind: 'taken', path: '/p' }] as const) expect(worktreeRequest(p, 'n', 'main')).toBeNull()
  })
})
