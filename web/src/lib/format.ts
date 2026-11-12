// How terminals read on screen: the state chip, the program's name, where
// it runs and why it ended; and how a worktree's branch and changes read.

import type { DiffQuery } from './api'
import { dayClock, duration, relTime } from './time'
import type { Change, Commit, CommitFile, FolderView, Preset, TerminalView, Worktree } from './types'

export type ChipKind = 'blocked' | 'error' | 'waiting' | 'working' | 'none' | 'exited'

export interface ChipInfo {
  kind: ChipKind
  label: string
}

/** The state of a live terminal as its queue group knows it (spec §3 #122). */
export function stateKind(t: TerminalView): ChipKind {
  if (t.state === 'finished') return 'exited'
  switch (t.status?.state) {
    case 'blocked': return 'blocked'
    case 'error': return 'error'
    case 'done':
    case 'idle': return 'waiting'
    case 'working': return 'working'
    default: return 'none'
  }
}

const LABELS: Record<ChipKind, string> = {
  blocked: '승인 대기',
  error: '오류',
  waiting: '입력 대기',
  working: '작업 중',
  none: '상태 없음',
  exited: '종료',
}

export function chip(t: TerminalView): ChipInfo {
  const kind = stateKind(t)
  const p = t.status?.progress
  if (kind === 'working' && p != null) return { kind, label: `작업 중 ${p}%` }
  return { kind, label: LABELS[kind] }
}

export interface SinceInfo {
  /** "12분째" while it works, "3분 전" once it stopped or asked. */
  text: string
  /** "오늘 14:12부터 작업 중". */
  title: string
}

/**
 * How long a live terminal has been in its state (spec §3 #189). hc's
 * status_ms moves when the program's word changes, not with its progress;
 * nothing when the program never said.
 */
export function since(t: TerminalView, now: number): SinceInfo | null {
  if (t.state === 'finished' || t.status_ms == null) return null
  const kind = stateKind(t)
  const d = now - t.status_ms
  const text = d < 60_000 ? '방금' : kind === 'working' ? `${duration(d)}째` : relTime(t.status_ms, now)
  return { text, title: `${dayClock(t.status_ms, now)}부터 ${LABELS[kind]}` }
}

/** The preset's name, else the program's file name; no program is the shell. */
export function appName(t: TerminalView, presets: Preset[]): string {
  const p = t.preset ? presets.find((x) => x.id === t.preset) : undefined
  if (p) return p.name
  const prog = t.argv[0]
  if (!prog) return '셸'
  return prog.split(/[\\/]/).pop()!.replace(/\.exe$/i, '')
}

export function shortHash(h: string): string {
  return h.slice(0, 7)
}

const HOME = /^(\/Users\/(?!Shared(?:\/|$))[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=$|[/\\])/

/** A version as people read it: v before a bare 1.2.3; a commit's hash or "dev" as it is. */
export function versionText(v: string): string {
  return /^\d+\.\d+/.test(v) ? 'v' + v : v
}

/** A path with the home folder written as ~. */
export function shortPath(p: string): string {
  return p.replace(HOME, '~')
}

/** The machine of a terminal of another host (machine/t7), else "". */
export function machineOf(addr: string): string {
  const i = addr.indexOf('/')
  return i < 0 ? '' : addr.slice(0, i)
}

/** A worktree by its branch, or by its commit's short hash when it has none. */
export function wtLabel(w: Worktree): string {
  return w.detached || !w.branch ? shortHash(w.head) : w.branch
}

/** The worktree a folder opens in: the one at its own path, else the main one, else any; none that is gone. */
export function homeWorktree(f: FolderView, ws: Worktree[]): Worktree | undefined {
  const ok = ws.filter((w) => !w.prunable)
  return ok.find((w) => w.path === f.path) ?? ok.find((w) => w.main) ?? ok[0]
}

/** The branch of the worktree t runs in, its short hash when detached, else "". */
export function branchOf(t: TerminalView, f: FolderView): string {
  const w = f.worktrees.find((x) => x.path === t.worktree)
  return w ? wtLabel(w) : ''
}

/** "Mori / main": the folder and the branch of the worktree it runs in. */
export function place(t: TerminalView, folders: FolderView[]): string {
  const f = t.folder_id ? folders.find((x) => x.id === t.folder_id) : undefined
  if (!f) {
    const m = machineOf(t.address)
    return (m ? m + ' · ' : '') + shortPath(t.cwd)
  }
  const b = branchOf(t, f)
  return b ? `${f.name} / ${b}` : f.name
}

const ASKS: Record<string, string> = {
  permission: '실행 허가를 기다립니다',
  question: '답을 기다립니다',
  auth: '인증이 필요합니다',
}

/** What a blocked or failing program says, else what it waits for. */
export function askText(t: TerminalView, kind: 'blocked' | 'error'): string {
  const m = t.status?.msg?.trim()
  if (m) return m
  if (kind === 'error') return '오류가 났습니다'
  return ASKS[t.status?.kind ?? ''] ?? '응답을 기다립니다'
}

const REASONS: Record<string, string> = {
  killed: '강제 종료',
  server_stop: '코어 종료',
  host_shutdown: '컴퓨터 종료',
  holder_lost: '실행기 끊김',
  stopped_by_restart: '재시작 뒤 멈춤',
  spawn_pending: '시작 대기',
}

export interface EndFacts {
  reason: string | null
  exit_code: number | null
  signal: number | null
}

/** Why a program ended: its exit code, its signal or the core's reason. */
export function endText(e: EndFacts): string {
  if (e.exit_code != null && (e.reason === 'exited' || e.reason == null)) return `코드 ${e.exit_code}`
  if (e.signal != null) return `신호 ${e.signal}`
  return REASONS[e.reason ?? ''] ?? '끝남'
}

interface BranchFacts {
  head: string
  branch: string
  detached: boolean
  upstream: string
  ahead: number
  behind: number
}

/** The branch a worktree is on, and how it stands to the remote one it follows. */
export function branchLine(s: BranchFacts): { name: string; sub: string } {
  if (s.detached) return { name: shortHash(s.head), sub: '브랜치가 아닌 커밋에 있습니다' }
  if (!s.head) return { name: s.branch, sub: '아직 커밋이 없습니다' }
  return { name: s.branch, sub: upstreamText(s) }
}

function upstreamText({ upstream, ahead, behind }: BranchFacts): string {
  if (!upstream) return '원격 브랜치 없음'
  if (ahead && behind) return `원격보다 ${ahead}개 앞서고 ${behind}개 뒤처짐`
  if (ahead) return `원격보다 ${ahead}개 앞섬`
  if (behind) return `원격보다 ${behind}개 뒤처짐`
  return '원격과 같음'
}

/** The name of a file, a folder keeping its slash, and the folder it is in ("" at the top). */
export function fileParts(path: string): { name: string; dir: string } {
  const slash = path.endsWith('/') ? '/' : ''
  const p = slash ? path.slice(0, -1) : path
  const i = p.lastIndexOf('/')
  return { name: p.slice(i + 1) + slash, dir: i < 0 ? '' : p.slice(0, i) }
}

export type ChangeGroupKey = 'conflict' | 'staged' | 'changed' | 'untracked'

/** How a change letter is coloured: --kind-m and the like, x for a conflict. */
export type ChangeTone = 'm' | 'a' | 'd' | 'r' | 'u' | 'x'

export interface ChangeItem {
  /** One per row of the list: the group and the path. */
  key: string
  path: string
  letter: string
  /** The letter in words, for whoever does not see it. */
  word: string
  tone: ChangeTone
  /** What else there is to know: a new folder, the path before, how a conflict came about. */
  note: string
  /** The diff the row opens. */
  diff: DiffQuery
}

export interface ChangeGroup {
  key: ChangeGroupKey
  label: string
  items: ChangeItem[]
}

const WORDS: Record<string, [string, ChangeTone]> = {
  M: ['수정', 'm'],
  A: ['추가', 'a'],
  D: ['삭제', 'd'],
  R: ['이름 바꿈', 'r'],
  C: ['복사', 'r'],
  T: ['종류 바뀜', 'm'],
  '?': ['추적 안 함', 'u'],
}

// git status's XY of an unmerged path: what our side and theirs did.
const CONFLICTS: Record<string, string> = {
  DD: '양쪽에서 삭제',
  AU: '우리가 추가',
  UD: '상대가 삭제',
  UA: '상대가 추가',
  DU: '우리가 삭제',
  AA: '양쪽에서 추가',
  UU: '양쪽에서 수정',
}

const GROUPS: [ChangeGroupKey, string][] = [
  ['conflict', '충돌'],
  ['staged', '스테이징됨'],
  ['changed', '변경'],
  ['untracked', '추적 안 함'],
]

function item(group: ChangeGroupKey, c: Change, letter: string, note: string, diff: DiffQuery): ChangeItem {
  const [word, tone] = group === 'conflict' ? ['충돌', 'x' as const] : (WORDS[letter] ?? ['바뀜', 'm' as const])
  return { key: `${group}:${c.path}`, path: c.path, letter, word, tone, note, diff }
}

/**
 * A worktree's changes as the Git panel lists them: the conflicts, what is
 * staged, what changed since and what git does not track. A file staged
 * and then changed again is in both of the middle groups.
 */
export function changeGroups(cs: Change[]): ChangeGroup[] {
  const by: Record<ChangeGroupKey, ChangeItem[]> = { conflict: [], staged: [], changed: [], untracked: [] }
  for (const c of cs) {
    const file = c.path
    if (c.kind === 'unmerged') {
      by.conflict.push(item('conflict', c, 'U', CONFLICTS[c.index + c.worktree] ?? '', { file }))
      continue
    }
    if (c.kind === 'untracked') {
      by.untracked.push(item('untracked', c, '?', file.endsWith('/') ? '새 폴더' : '', { file }))
      continue
    }
    if (c.index !== '.') {
      // Only the index knows the path before, so only its diff shows the rename.
      const moved = c.orig && (c.index === 'R' || c.index === 'C')
      const note = moved ? `${c.orig}에서 ${c.index === 'R' ? '옮김' : '복사'}` : ''
      by.staged.push(item('staged', c, c.index, note, moved ? { file, orig: c.orig, staged: true } : { file, staged: true }))
    }
    if (c.worktree !== '.') by.changed.push(item('changed', c, c.worktree, '', { file }))
  }
  return GROUPS.filter(([k]) => by[k].length > 0).map(([key, label]) => ({ key, label, items: by[key] }))
}

/** A file of a commit as its panel lists it: a change with its counts. */
export interface CommitItem extends ChangeItem {
  added: number
  deleted: number
  binary: boolean
}

const KIND_LETTERS: Record<string, string> = { added: 'A', deleted: 'D', modified: 'M', renamed: 'R', copied: 'C', typechange: 'T' }

/** A commit's files, each opening its diff against the first parent (spec §3 #110), a rename's or a copy's with the path before. */
export function commitItems(c: Commit): CommitItem[] {
  return c.files.map((f) => {
    const letter = KIND_LETTERS[f.kind] ?? 'M'
    const moved = f.orig && (letter === 'R' || letter === 'C') ? f.orig : ''
    const [word, tone] = WORDS[letter]
    return {
      key: moved ? `${moved}\n${f.path}` : f.path,
      path: f.path,
      letter,
      word,
      tone,
      note: moved ? `${moved}에서 ${letter === 'R' ? '옮김' : '복사'}` : '',
      diff: moved ? { rev: c.hash, file: f.path, orig: moved } : { rev: c.hash, file: f.path },
      added: f.added,
      deleted: f.deleted,
      binary: f.binary,
    }
  })
}

/** A commit message as git shows it: the first paragraph on one line, then the rest. */
export function splitMessage(message: string): { subject: string; body: string } {
  const lines = message.replace(/\r\n?/g, '\n').split('\n')
  const blank = (l: string) => l.trim() === ''
  let i = 0
  while (i < lines.length && blank(lines[i])) i++
  const head: string[] = []
  for (; i < lines.length && !blank(lines[i]); i++) head.push(lines[i].trim())
  // Blank lines go from the ends of the body, an indented first line keeps its room.
  const body = lines.slice(i).join('\n').replace(/^\s*\n|\s+$/g, '')
  return { subject: head.join(' '), body }
}

/** The lines a commit's files add and delete. */
export function fileTotals(files: CommitFile[]): { added: number; deleted: number } {
  return files.reduce((t, f) => ({ added: t.added + f.added, deleted: t.deleted + f.deleted }), { added: 0, deleted: 0 })
}
