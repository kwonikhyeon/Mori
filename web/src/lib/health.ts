// What the screen says about the server and the core (spec §3 #131): a
// banner while something is wrong, and the dot next to the host's name.
import type { Problem } from './scope'
import type { Conn } from './store'
import type { CoreStatus } from './types'

export interface BannerInfo {
  kind: 'warn' | 'error' | 'info'
  title: string
  detail: string
}

/** The banner for the connection, or null when all is well. */
export function connBanner(c: Conn, core: CoreStatus): BannerInfo | null {
  switch (c) {
    case 'down':
      return { kind: 'warn', title: '서버에 다시 연결하는 중', detail: '보이는 내용은 마지막으로 받은 상태입니다.' }
    case 'restarting':
      return { kind: 'info', title: '서버 재시작 중', detail: '곧 다시 연결합니다.' }
    case 'connecting':
      return null // the first two seconds go unsaid
    case 'open':
      if (core.connected) return null
      if (core.error?.includes('hc not found')) {
        return { kind: 'error', title: 'herdr-core가 설치되지 않음', detail: '서버 컴퓨터에 herdr-core를 설치하거나 mori serve --hc로 경로를 알려 주세요.' }
      }
      return { kind: 'warn', title: '코어 연결 중', detail: '세션을 열고 보려면 herdr-core가 필요합니다.' }
  }
}

export type Dot = 'ok' | 'warn' | 'off' | 'bad'

/** The dot and the word next to the host's name. */
export function hostState(c: Conn, core: CoreStatus): { dot: Dot; text: string } {
  switch (c) {
    case 'open':
      return core.connected ? { dot: 'ok', text: '연결됨' } : { dot: 'warn', text: '코어 연결 중' }
    case 'connecting':
      return { dot: 'off', text: '연결 중' }
    case 'restarting':
      return { dot: 'warn', text: '재시작 중' }
    case 'down':
      return { dot: 'bad', text: '연결 끊김' }
  }
}

/** The same for a host of the hub: what keeps the page from it comes first. */
export function scopeState(c: Conn, core: CoreStatus, problem: Problem): { dot: Dot; text: string } {
  if (problem === 'unlinked') return { dot: 'off', text: '끊김' }
  if (problem === 'unreachable') return { dot: 'bad', text: '닿지 못함' }
  return hostState(c, core)
}
