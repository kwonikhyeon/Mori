// What Claude Code draws at the bottom of its screen while no window shows
// (claude-input design §3, §4.2): its input box, the status line below it,
// set by the person, and its mode line. The box is empty while what it holds
// is one grey only, a hint or a suggestion; any other colour is text a send
// would carry, so a reading that errs, errs toward text.

import { inputBox, look } from './pick'
import type { Shot } from './shot'

export interface Mode {
  /** The mode as the screen names it: 'bypass permissions'; '' for the default. */
  name: string
  /** What Mori calls it. */
  label: string
  /** What follows it after "·", in words: "셸 1". */
  extras: string[]
}

export interface BoxLook {
  /** The buffer line of the rule over the input box. */
  top: number
  /** From that rule to the last line written: what the cover covers. */
  rows: number
  /** What the box holds, its lines joined by \n; '' while only a hint shows, or nothing. */
  text: string
  /** The grey hint or suggestion of an empty box; '' for none. */
  hint: string
  /** The lines below the box but the mode line, without their indent. */
  status: string[]
  mode: Mode | null
}

const LABELS: Record<string, string> = {
  'accept edits': '편집 자동 허락',
  'plan mode': '계획',
  'bypass permissions': '묻지 않음',
  'auto mode': '자동',
}

/** A grey: three near values from 64 to 200, or the palette's 8 and 240 to 250. */
export function isGrey(ink: string): boolean {
  const p = /^p:(\d+)$/.exec(ink)
  if (p) {
    const n = Number(p[1])
    return n === 8 || (n >= 240 && n <= 250)
  }
  const m = /^rgb:(\d+),(\d+),(\d+)$/.exec(ink)
  if (!m) return false
  const v = [Number(m[1]), Number(m[2]), Number(m[3])]
  return Math.max(...v) - Math.min(...v) <= 8 && v.every((x) => x >= 64 && x <= 200)
}

const extra = (s: string) => s.replace(/^(\d+) shells?$/, '셸 $1')

/** Claude Code's mode line: "⏵⏵ <name> on", "⏸ <name> on", or "? for shortcuts". */
export function readMode(line: string): Mode | null {
  const t = line.trim()
  let name: string
  let rest: string
  const m = /^(?:⏵⏵|⏸)\s+(.+?)\s+on\b(.*)$/.exec(t)
  if (m) {
    name = m[1]
    rest = m[2]
  } else if (/^\?\s+for shortcuts\b/.test(t)) {
    name = ''
    rest = t.replace(/^\?\s+for shortcuts\b/, '')
  } else return null
  // what follows: a notice at the right of the line, then pieces after "·"; the cycle hint is no extra
  const extras = rest
    .split('·')
    .map((s, i) => (i === 0 && /^\(.*shift\+tab.*\)$/i.test(s.trim()) ? '' : extra(s.trim())))
    .filter(Boolean)
  return { name, label: name ? (LABELS[name] ?? name) : '기본', extras }
}

/** The input box and what is below it; null with a window, or no box. */
export function readBox(shot: Shot): BoxLook | null {
  if (look(shot).seen) return null
  const texts = shot.lines.map((l) => l.join('').trimEnd())
  const b = inputBox(texts, shot.cols)
  if (!b) return null
  const [top, bottom] = b
  // the box's own cells: after "❯ " on its first line, after the indent below
  const lines: string[] = []
  const inks: string[] = []
  for (let y = top + 1; y < bottom; y++) {
    const cells = shot.lines[y]
    const from = y === top + 1 ? cells.indexOf('❯') + 2 : 2
    lines.push(cells.slice(from).join('').trimEnd())
    cells.forEach((c, x) => {
      if (x >= from && c !== ' ' && c !== '') inks.push(shot.ink[y]?.[x] ?? '')
    })
  }
  const said = lines.join('\n').trim()
  const hinted = inks.length > 0 && inks.every((i) => i === inks[0]) && isGrey(inks[0])
  const below = texts.slice(bottom + 1).map((t) => t.trim()).filter(Boolean)
  const mode = below.length ? readMode(below[below.length - 1]) : null
  return {
    top: shot.top + top,
    rows: texts.length - top,
    text: hinted ? '' : said,
    hint: hinted ? said : '',
    status: mode ? below.slice(0, -1) : below,
    mode,
  }
}
