import { describe, expect, it } from 'vitest'
import { folder, status, term, worktree } from '../../test/fixtures'
import { appName, askLine, askText, branchLine, branchOf, changeGroups, chip, commitItems, endText, fileParts, fileTotals, homeWorktree, place, shortHash, shortPath, since, splitMessage, versionText } from './format'
import type { Change, Commit, CommitFile, Preset } from './types'

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

describe('since', () => {
  const NOW = 100 * 3_600_000
  const MIN = 60_000

  it('counts how long it has worked, and how long ago it stopped or asked', () => {
    expect(since(term({ status: status('working'), status_ms: NOW - 12 * MIN }), NOW)?.text).toBe('12분째')
    expect(since(term({ status: status('working'), status_ms: NOW - 65 * MIN }), NOW)?.text).toBe('1시간 5분째')
    expect(since(term({ status: status('idle'), status_ms: NOW - 3 * MIN }), NOW)?.text).toBe('3분 전')
    expect(since(term({ status: status('blocked'), status_ms: NOW - 2 * 3_600_000 }), NOW)?.text).toBe('2시간 전')
  })

  it('says 방금 within a minute, also for a host whose clock runs ahead', () => {
    expect(since(term({ status: status('working'), status_ms: NOW - 20_000 }), NOW)?.text).toBe('방금')
    expect(since(term({ status: status('done'), status_ms: NOW + 5_000 }), NOW)?.text).toBe('방금')
  })

  it('tells when the state began', () => {
    const at = new Date(2026, 10, 9, 14, 12).getTime()
    expect(since(term({ status: status('working'), status_ms: at }), at + 5 * MIN)?.title).toBe('오늘 14:12부터 작업 중')
  })

  it('says nothing of a program that never said or that ended', () => {
    expect(since(term(), NOW)).toBeNull()
    expect(since(term({ state: 'finished', status: status('done'), status_ms: NOW - MIN }), NOW)).toBeNull()
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

describe('homeWorktree', () => {
  const main = worktree()
  const sub = worktree({ path: '/Users/me/dev/Mori/web', branch: 'web', main: false })
  const gone = worktree({ path: '/Users/me/dev/Mori.wt/gone', branch: 'gone', main: false, prunable: true })
  it('is the folder’s own, else the main one, else any that is there', () => {
    expect(homeWorktree(folder({ path: sub.path }), [main, sub])).toBe(sub)
    expect(homeWorktree(folder({ path: '/Users/me/dev/elsewhere' }), [sub, main])).toBe(main)
    expect(homeWorktree(folder({ path: '/Users/me/dev/elsewhere' }), [gone, sub])).toBe(sub)
    expect(homeWorktree(folder({ path: gone.path }), [gone])).toBeUndefined()
    expect(homeWorktree(folder(), [])).toBeUndefined()
  })
})

describe('versionText', () => {
  it('writes v before a released version and leaves a build of a commit as it is', () => {
    expect(versionText('0.1.0')).toBe('v0.1.0')
    expect(versionText('v0.1.0')).toBe('v0.1.0')
    expect(versionText('3f6187f-dirty')).toBe('3f6187f-dirty')
    expect(versionText('dev')).toBe('dev')
  })
})

describe('shortPath', () => {
  it('writes the home folder as ~', () => {
    expect(shortPath('/Users/me/dev/proj')).toBe('~/dev/proj')
    expect(shortPath('/Users/me')).toBe('~')
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
})

describe('shortHash', () => {
  it('keeps seven characters', () => {
    expect(shortHash('a1b2c3d4e5f6')).toBe('a1b2c3d')
  })
})

describe('askText', () => {
  it("prefers the program's own words, else says what it waits for", () => {
    expect(askText(term({ status: status('blocked', { msg: '  rm -rf build 실행?  ' }) }), 'blocked')).toBe('rm -rf build 실행?')
    expect(askText(term({ status: status('blocked', { kind: 'permission' }) }), 'blocked')).toBe('실행 허가를 기다립니다')
    expect(askText(term({ status: status('blocked', { kind: 'question' }) }), 'blocked')).toBe('답을 기다립니다')
    expect(askText(term({ status: status('blocked', { kind: 'auth' }) }), 'blocked')).toBe('인증이 필요합니다')
    expect(askText(term({ status: status('blocked') }), 'blocked')).toBe('응답을 기다립니다')
    expect(askText(term({ status: status('error') }), 'error')).toBe('오류가 났습니다')
  })
})

// The approval bar says what is asked, not its choices: the terminal above shows them (spec §3 #238).
describe('askLine', () => {
  it("drops a Claude Code question's choices and its answer: tag", () => {
    const q = (msg: string) => askLine(term({ status: status('blocked', { kind: 'question', msg }) }))
    expect(q('answer: 어떤 반려동물을 좋아하시나요? (Cat · Dog · Bird)')).toBe('어떤 반려동물을 좋아하시나요?')
    expect(q('answer: 계속할까요?')).toBe('계속할까요?')
    expect(q('answer: f(x)를 쓸까요? (예 · 아니요)')).toBe('f(x)를 쓸까요?')
    // other words are left as they are
    expect(q('approve plan')).toBe('approve plan')
    expect(q('Bash(ls -la)를 실행할까요?')).toBe('Bash(ls -la)를 실행할까요?')
    expect(q('answer: (A · B)')).toBe('answer: (A · B)')
    expect(askLine(term({ status: status('blocked', { kind: 'question' }) }))).toBe('답을 기다립니다')
  })
})


const ch = (path: string, xy: string, kind = 'changed', orig?: string): Change => ({
  path,
  index: xy[0],
  worktree: xy[1],
  kind,
  ...(orig ? { orig } : {}),
})

describe('changeGroups', () => {
  it('puts conflicts first, then the staged, changed and untracked files', () => {
    const gs = changeGroups([
      ch('web/a.ts', '.M'),
      ch('new/', '??', 'untracked'),
      ch('docs/b.md', 'MM'),
      ch('x.go', 'UU', 'unmerged'),
      ch('c.txt', 'A.'),
    ])
    expect(gs.map((g) => [g.label, g.items.map((i) => `${i.letter} ${i.path}`)])).toEqual([
      ['충돌', ['U x.go']],
      // A file changed again after it was staged is in both.
      ['스테이징됨', ['M docs/b.md', 'A c.txt']],
      ['변경', ['M web/a.ts', 'M docs/b.md']],
      ['추적 안 함', ['? new/']],
    ])
    expect(new Set(gs.flatMap((g) => g.items.map((i) => i.key))).size).toBe(6)
    expect(changeGroups([])).toEqual([])
  })

  it('asks for the diff each row shows', () => {
    const [staged, changed] = changeGroups([ch('문서/새 이름.md', 'RM', 'renamed', 'old.md'), ch('i.txt', '.A')])
    expect(staged.items.map((i) => i.diff)).toEqual([{ file: '문서/새 이름.md', orig: 'old.md', staged: true }])
    expect(changed.items.map((i) => i.diff)).toEqual([{ file: '문서/새 이름.md' }, { file: 'i.txt' }])
    const [conflict, untracked] = changeGroups([ch('x.go', 'AA', 'unmerged'), ch('n/', '??', 'untracked')])
    expect(conflict.items[0].diff).toEqual({ file: 'x.go' })
    expect(untracked.items[0].diff).toEqual({ file: 'n/' })
  })

  it('says in words what the letter says, and what else to know', () => {
    const items = changeGroups([
      ch('a', 'M.'),
      ch('b', 'A.'),
      ch('c', 'D.'),
      ch('d', 'R.', 'renamed', 'docs/d0'),
      ch('e', 'C.', 'renamed', 'e0'),
      ch('f', 'T.'),
      ch('g/h/', '??', 'untracked'),
      ch('i', '??', 'untracked'),
    ]).flatMap((g) => g.items)
    expect(items.map((i) => [i.letter, i.word, i.tone, i.note])).toEqual([
      ['M', '수정', 'm', ''],
      ['A', '추가', 'a', ''],
      ['D', '삭제', 'd', ''],
      ['R', '이름 바꿈', 'r', 'docs/d0에서 옮김'],
      ['C', '복사', 'r', 'e0에서 복사'],
      ['T', '종류 바뀜', 'm', ''],
      ['?', '추적 안 함', 'u', '새 폴더'],
      ['?', '추적 안 함', 'u', ''],
    ])
  })

  it('says how a conflict came about', () => {
    const xys = ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']
    const [g] = changeGroups(xys.map((xy) => ch(xy, xy, 'unmerged')))
    expect(g.items.map((i) => [i.letter, i.word, i.tone, i.note])).toEqual([
      ['U', '충돌', 'x', '양쪽에서 삭제'],
      ['U', '충돌', 'x', '우리가 추가'],
      ['U', '충돌', 'x', '상대가 삭제'],
      ['U', '충돌', 'x', '상대가 추가'],
      ['U', '충돌', 'x', '우리가 삭제'],
      ['U', '충돌', 'x', '양쪽에서 추가'],
      ['U', '충돌', 'x', '양쪽에서 수정'],
    ])
  })
})

describe('fileParts', () => {
  it('is the name and the folder it is in', () => {
    expect(fileParts('internal/push/notify.go')).toEqual({ name: 'notify.go', dir: 'internal/push' })
    expect(fileParts('README.md')).toEqual({ name: 'README.md', dir: '' })
    expect(fileParts('internal/push/testdata/')).toEqual({ name: 'testdata/', dir: 'internal/push' })
    expect(fileParts('new/')).toEqual({ name: 'new/', dir: '' })
  })
})

describe('branchLine', () => {
  const s = { head: 'a1b2c3d4e5f6', branch: 'main', detached: false, upstream: 'origin/main', ahead: 0, behind: 0 }
  it('says how the branch stands to its remote', () => {
    expect(branchLine(s)).toEqual({ name: 'main', sub: '원격과 같음' })
    expect(branchLine({ ...s, ahead: 2 }).sub).toBe('원격보다 2개 앞섬')
    expect(branchLine({ ...s, behind: 3 }).sub).toBe('원격보다 3개 뒤처짐')
    expect(branchLine({ ...s, ahead: 2, behind: 3 }).sub).toBe('원격보다 2개 앞서고 3개 뒤처짐')
    expect(branchLine({ ...s, upstream: '' })).toEqual({ name: 'main', sub: '원격 브랜치 없음' })
  })

  it('names a commit off any branch, and a branch with no commit yet', () => {
    expect(branchLine({ ...s, branch: '', detached: true, upstream: '' })).toEqual({ name: 'a1b2c3d', sub: '브랜치가 아닌 커밋에 있습니다' })
    expect(branchLine({ ...s, head: '', upstream: '' })).toEqual({ name: 'main', sub: '아직 커밋이 없습니다' })
  })
})

describe('commitItems', () => {
  const H = 'c'.repeat(40)
  const file = (path: string, kind: string, over: Partial<CommitFile> = {}): CommitFile => ({ path, kind, added: 1, deleted: 0, binary: false, ...over })
  const commit = (files: CommitFile[]): Commit => ({
    hash: H,
    parents: [],
    author: 'me',
    email: 'me@example.com',
    author_ms: 0,
    committer: 'me',
    committer_email: 'me@example.com',
    commit_ms: 0,
    message: 's',
    files,
    truncated: false,
  })

  it('reads a commit file as the Git panel reads a change', () => {
    const items = commitItems(
      commit([
        file('a', 'modified'),
        file('b', 'added'),
        file('c', 'deleted'),
        file('docs/d', 'renamed', { orig: 'docs/d0' }),
        file('e', 'copied', { orig: 'e0' }),
        file('f', 'typechange'),
        file('g', 'something new'),
      ]),
    )
    expect(items.map((i) => [i.letter, i.word, i.tone, i.note])).toEqual([
      ['M', '수정', 'm', ''],
      ['A', '추가', 'a', ''],
      ['D', '삭제', 'd', ''],
      ['R', '이름 바꿈', 'r', 'docs/d0에서 옮김'],
      ['C', '복사', 'r', 'e0에서 복사'],
      ['T', '종류 바뀜', 'm', ''],
      ['M', '수정', 'm', ''],
    ])
    expect(new Set(items.map((i) => i.key)).size).toBe(7)
  })

  it('asks for the diff against the first parent, with the path before a rename or a copy', () => {
    const items = commitItems(commit([file('x.go', 'modified'), file('new.md', 'renamed', { orig: 'old.md' }), file('k', 'copied', { orig: 'k0' })]))
    expect(items.map((i) => i.diff)).toEqual([
      { rev: H, file: 'x.go' },
      { rev: H, file: 'new.md', orig: 'old.md' },
      { rev: H, file: 'k', orig: 'k0' },
    ])
  })

  it('keeps the counts, which a binary file has none of', () => {
    const [t, b] = commitItems(commit([file('t', 'modified', { added: 3, deleted: 2 }), file('b.png', 'added', { added: 0, binary: true })]))
    expect([t.added, t.deleted, t.binary]).toEqual([3, 2, false])
    expect([b.added, b.deleted, b.binary]).toEqual([0, 0, true])
  })
})

describe('splitMessage', () => {
  it('takes the first paragraph as the subject and the rest as the body', () => {
    expect(splitMessage('feat: 그래프\n\n행마다 SVG 하나.\n색은 칸마다.\n')).toEqual({ subject: 'feat: 그래프', body: '행마다 SVG 하나.\n색은 칸마다.' })
  })

  it('joins a subject that runs over lines, as git does', () => {
    expect(splitMessage('fix: a long\nsubject line\n\nbody')).toEqual({ subject: 'fix: a long subject line', body: 'body' })
  })

  it('reads CRLF and blank lines with spaces, and a message with no body', () => {
    expect(splitMessage('  one\r\n \r\n\r\ntwo\r\n\r\nthree  ')).toEqual({ subject: 'one', body: 'two\n\nthree' })
    expect(splitMessage('only\n')).toEqual({ subject: 'only', body: '' })
    expect(splitMessage('')).toEqual({ subject: '', body: '' })
  })
})

describe('fileTotals', () => {
  const file = (path: string, kind: string, over: Partial<CommitFile> = {}): CommitFile => ({ path, kind, added: 1, deleted: 0, binary: false, ...over })

  it('adds the lines of the files, of which a binary one has none', () => {
    expect(fileTotals([file('a', 'modified', { added: 3, deleted: 1 }), file('b', 'added', { added: 5, deleted: 0 }), file('c.png', 'added', { added: 0, binary: true })])).toEqual({ added: 8, deleted: 1 })
    expect(fileTotals([])).toEqual({ added: 0, deleted: 0 })
  })
})
