// A small history for the graph's tests: fix/notify branched off the first
// commit and was merged back into main, which HEAD is on.
//
//   C  fix/notify 병합         main, origin/main, v0.2.0
//   |\
//   | B  알림이 두 번 뜨던 문제 고침   fix/notify
//   |/
//   A  처음

import type { Commit, CommitFile, Graph, LogCommit } from '../src/lib/types'

export const MAIN = '/Users/me/dev/Mori'
export const MIN = 60_000
export const HOUR = 60 * MIN
/** Noon, so an hour ago is still today wherever the tests run. */
export const NOW = new Date(2026, 10, 9, 12, 0).getTime()

export const A = 'a'.repeat(40)
export const B = 'b'.repeat(40)
export const C = 'c'.repeat(40)

/** The hash of the nth commit of a made-up long history. */
export const nth = (n: number) => n.toString(16).padStart(7, '0') + 'f'.repeat(33)

export function logCommit(hash: string, over: Partial<LogCommit> = {}): LogCommit {
  return { hash, parents: [], author: '김하늘', time_ms: NOW - HOUR, subject: '커밋 ' + hash.slice(0, 7), refs: [], lane: 0, color: 0, up: [], pass: [], down: [], ...over }
}

export const LOG: Graph = {
  width: 2,
  more: false,
  commits: [
    logCommit(C, {
      parents: [A, B],
      subject: 'fix/notify 병합',
      time_ms: NOW - 5 * MIN,
      refs: [
        { name: 'main', kind: 'branch', current: true },
        { name: 'origin/main', kind: 'remote', current: false },
        { name: 'v0.2.0', kind: 'tag', current: false },
      ],
      down: [
        { lane: 0, color: 0 },
        { lane: 1, color: 1 },
      ],
    }),
    logCommit(B, {
      parents: [A],
      author: 'Lee',
      subject: '알림이 두 번 뜨던 문제 고침',
      refs: [{ name: 'fix/notify', kind: 'branch', current: false }],
      lane: 1,
      color: 1,
      up: [{ lane: 1, color: 1 }],
      pass: [{ lane: 0, color: 0 }],
      down: [{ lane: 0, color: 1 }],
    }),
    logCommit(A, {
      subject: '처음',
      time_ms: NOW - 3 * 24 * HOUR,
      up: [
        { lane: 0, color: 0 },
        { lane: 0, color: 1 },
      ],
    }),
  ],
}

/** A straight line of n commits, the newest first. */
export function linear(n: number, more: boolean): Graph {
  const commits = Array.from({ length: n }, (_, i) =>
    logCommit(nth(i), {
      parents: i < n - 1 || more ? [nth(i + 1)] : [],
      up: i > 0 ? [{ lane: 0, color: 0 }] : [],
      down: i < n - 1 || more ? [{ lane: 0, color: 0 }] : [],
    }),
  )
  return { width: 1, more, commits }
}

export function file(path: string, over: Partial<CommitFile> = {}): CommitFile {
  return { path, kind: 'modified', added: 1, deleted: 1, binary: false, ...over }
}

export function commit(hash: string, over: Partial<Commit> = {}): Commit {
  return {
    hash,
    parents: [],
    author: '김하늘',
    email: 'sky@example.com',
    author_ms: NOW - HOUR,
    committer: '김하늘',
    committer_email: 'sky@example.com',
    commit_ms: NOW - HOUR,
    message: '커밋\n',
    files: [],
    truncated: false,
    ...over,
  }
}

export const COMMITS: Record<string, Commit> = {
  [C]: commit(C, {
    parents: [A, B],
    message: 'fix/notify 병합\n\n알림 고침을 가져옵니다.\n',
    author_ms: NOW - 5 * MIN,
    commit_ms: NOW - 5 * MIN,
    files: [
      file('internal/push/notify.go', { added: 3, deleted: 1 }),
      file('docs/new.md', { orig: 'docs/old.md', kind: 'renamed', added: 0, deleted: 0 }),
      file('web/public/icon.png', { kind: 'added', added: 0, deleted: 0, binary: true }),
    ],
  }),
  [B]: commit(B, {
    parents: [A],
    author: 'Lee',
    email: 'lee@example.com',
    committer: 'Lee',
    committer_email: 'lee@example.com',
    message: '알림이 두 번 뜨던 문제 고침\n\n푸시가 두 번 보내지던 것을 막습니다.\n',
    files: [file('internal/push/notify.go', { added: 2, deleted: 2 }), file('internal/push/notify_test.go', { kind: 'added', added: 12, deleted: 0 })],
  }),
  [A]: commit(A, { message: '처음\n', author_ms: NOW - 3 * 24 * HOUR, commit_ms: NOW - 3 * 24 * HOUR, files: [file('README.md', { kind: 'added', added: 4, deleted: 0 })] }),
}

export const diffOf = (file: string) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old ${file}\n+new ${file}\n`
