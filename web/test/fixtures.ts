// Values for tests: a whole object with only what a test cares about set.

import type { FolderView, Status, TerminalView, Worktree } from '../src/lib/types'

export function term(over: Partial<TerminalView> = {}): TerminalView {
  return {
    address: 't1',
    argv: ['claude'],
    cols: 80,
    rows: 24,
    created_ms: 1_000,
    cwd: '/Users/me/dev/Mori',
    labels: {},
    screen: '',
    state: 'live',
    die_with_parent: false,
    identity: '',
    keep: true,
    notify: true,
    records: null,
    reported: false,
    rm: false,
    title: '',
    turn: 0,
    exit_code: null,
    finished_ms: null,
    first_message: null,
    foreground: null,
    name: null,
    parent: null,
    paste_gap_ms: null,
    pid: 100,
    reason: null,
    signal: null,
    status: null,
    status_ms: null,
    stop: null,
    submit: null,
    template: null,
    folder_id: 'f1',
    worktree: '/Users/me/dev/Mori',
    display_title: 'Claude Code',
    preset: 'claude',
    ...over,
  }
}

export function status(state: string, over: Partial<Status> = {}): Status {
  return { state, app: 'claude', kind: null, msg: '', progress: null, title: '', ...over }
}

export function worktree(over: Partial<Worktree> = {}): Worktree {
  return {
    path: '/Users/me/dev/Mori',
    head: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    branch: 'main',
    main: true,
    bare: false,
    detached: false,
    locked: false,
    prunable: false,
    ...over,
  }
}

export function folder(over: Partial<FolderView> = {}): FolderView {
  return {
    id: 'f1',
    name: 'Mori',
    path: '/Users/me/dev/Mori',
    created_ms: 1,
    repo: true,
    worktrees: [worktree()],
    ...over,
  }
}
