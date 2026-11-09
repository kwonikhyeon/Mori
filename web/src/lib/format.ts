// How terminals read on screen: the state chip, the program's name, where
// it runs and why it ended.

import { relTime } from './time'
import type { FolderView, Preset, TerminalView } from './types'

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

/** A path with the home folder written as ~. */
export function shortPath(p: string): string {
  return p.replace(HOME, '~')
}

/** The machine of a terminal of another host (machine/t7), else "". */
export function machineOf(addr: string): string {
  const i = addr.indexOf('/')
  return i < 0 ? '' : addr.slice(0, i)
}

/** "Mori / main": the folder and the branch of the worktree it runs in. */
export function place(t: TerminalView, folders: FolderView[]): string {
  const f = t.folder_id ? folders.find((x) => x.id === t.folder_id) : undefined
  if (!f) {
    const m = machineOf(t.address)
    return (m ? m + ' · ' : '') + shortPath(t.cwd)
  }
  const w = f.worktrees.find((x) => x.path === t.worktree)
  if (!w) return f.name
  return `${f.name} / ${w.detached || !w.branch ? shortHash(w.head) : w.branch}`
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

/** "셸 · 코드 0 · 2시간 전" */
export function finishedLine(t: TerminalView, presets: Preset[], now: number): string {
  const parts = [appName(t, presets), endText(t)]
  if (t.finished_ms != null) parts.push(relTime(t.finished_ms, now))
  return parts.join(' · ')
}
