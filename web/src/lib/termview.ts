// What the terminal screen says about its connection, and the small
// conversions it needs (spec §3 #123, #126, #133).

import type { AttachState } from './attach'

export interface AttachNote {
  kind: 'info' | 'warn' | 'error'
  title: string
  detail: string
  /** The connection is being retried. */
  spin: boolean
  /** Shown only when it lasts, so a quick connect does not flash. */
  late: boolean
}

const note = (kind: AttachNote['kind'], title: string, detail = '', spin = false, late = false): AttachNote =>
  ({ kind, title, detail, spin, late })

/** The note over the screen while it is not live; an ended program has its own bar. */
export function attachNote(state: AttachState, reason: string): AttachNote | null {
  switch (state) {
    case 'connecting': return note('info', '연결 중', '', true, true)
    case 'waiting-core': return note('warn', '코어 연결 중', 'herdr-core가 돌아오면 이어서 보여 줍니다.', true)
    case 'recovering': return note('warn', '복구 대기', '코어가 이 터미널을 되살리는 중입니다.', true)
    case 'reconnecting': return note('info', '다시 연결하는 중', '', true)
    case 'gone': return note('error', '터미널을 찾을 수 없습니다', '이미 지워졌거나 다른 컴퓨터의 터미널입니다.')
    case 'error': return note('error', '터미널을 열 수 없습니다', reason)
    default: return null
  }
}

export interface AnswerKey {
  label: string
  /** What the key types into the terminal. */
  bytes: string
  /** The key's name for POST keys, when the screen is not attached. */
  name: string
}

const ANSWERS: Record<string, AnswerKey> = {
  1: { label: '1', bytes: '1', name: '1' },
  2: { label: '2', bytes: '2', name: '2' },
  3: { label: '3', bytes: '3', name: '3' },
  enter: { label: 'Enter', bytes: '\r', name: 'enter' },
  esc: { label: 'Esc', bytes: '\x1b', name: 'esc' },
}

/** The keys a blocked program is answered with on a PC (B-PC, B-Terminal); a phone types its own (spec §3 #250). */
export const BLOCKED_KEYS: AnswerKey[] = [ANSWERS[1], ANSWERS[2], ANSWERS[3], ANSWERS.enter, ANSWERS.esc]

/** An uploaded file's path as a shell reads it as one word. */
export function quotePath(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p
}

/** Screen text with the line endings a terminal moves down with. */
export function screenText(s: string): string {
  return s.replace(/\r?\n/g, '\r\n')
}
