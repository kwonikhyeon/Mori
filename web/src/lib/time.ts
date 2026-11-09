// Times in Korean (spec §3 #132): how long ago in lists, the clock as well
// in a commit's details. Calendar days are the browser's local ones.

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

function startOfDay(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** Calendar days from then to now; rounding absorbs a DST hour. */
function daysBetween(then: number, now: number): number {
  return Math.round((startOfDay(now) - startOfDay(then)) / DAY)
}

function date(ms: number, now: number): string {
  const d = new Date(ms)
  const md = `${d.getMonth() + 1}월 ${d.getDate()}일`
  return d.getFullYear() === new Date(now).getFullYear() ? md : `${d.getFullYear()}년 ${md}`
}

export function relTime(ms: number, now: number): string {
  const diff = now - ms
  if (diff < MIN) return '방금'
  if (diff < HOUR) return `${Math.floor(diff / MIN)}분 전`
  if (diff < DAY) return `${Math.floor(diff / HOUR)}시간 전`
  const days = daysBetween(ms, now)
  if (days <= 1) return '어제'
  if (days < 7) return `${days}일 전`
  return date(ms, now)
}

export function clock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** "오늘 14:12 (1시간 전)"; the part in brackets is left out when it would repeat the day. */
export function commitTime(ms: number, now: number): string {
  const days = daysBetween(ms, now)
  const day = days === 0 ? '오늘' : days === 1 ? '어제' : date(ms, now)
  const rel = relTime(ms, now)
  const repeats = rel === '어제' || !/(전|방금)$/.test(rel)
  return `${day} ${clock(ms)}` + (repeats ? '' : ` (${rel})`)
}
