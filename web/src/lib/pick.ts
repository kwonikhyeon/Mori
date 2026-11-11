// What Claude Code's window at the bottom of a terminal asks (pickers design
// §6.2, §6.3, §6.6): a numbered list with one cursor, on an item or on a row
// without a number below them, or a window with only a hint line, and where
// the input box stands. It reads cells, not bytes, so a wide letter, a frame
// and a wrapped line all count as the screen draws them.
// A list is read only when nothing else on the screen could be it: Claude's
// answers and what the user types sit above or inside the input box, so a
// list with the box below it, or in it, is no window.

import { hintLine, readHints, type Hint, type HintPart } from './hints'
import type { Shot } from './shot'

/** How many lines of the bottom of the screen a look reads. */
export const DEPTH = 40

export interface Option {
  n: number
  label: string
  desc: string
  /** A checkbox's state, or the item in use now. */
  mark: '' | 'on' | 'off' | 'current'
}

export interface Seen {
  /** Stays while the cursor moves: the title and the labels. */
  id: string
  /** Stays while a redraw cuts the title too: the labels, or the hint line of a window with no list. */
  form: string
  /** Changes with anything the window shows, the cursor included. */
  sig: string
  title: string
  options: Option[]
  /** The item the cursor is on; 0 when there is no list, or when it stands on a row without a number. */
  cursor: number
  hints: Hint[]
  /** What the window shows above its hint line. */
  body: string
  /** From the window's first line to its hint line. */
  rows: number
  /**
   * The terminal is too short for the whole list: Claude Code shows some of
   * its items, how many more there are ("… +4 models"), and scrolls them with
   * ↑ and ↓ beside the numbers. The options are what it shows.
   */
  partial: boolean
}

export interface Box {
  /** The buffer line of the rule above the input box. */
  top: number
  rows: number
}

export interface Look {
  seen: Seen | null
  box: Box | null
}

export const NOTHING: Look = { seen: null, box: null }

/**
 * The same window, as far as a look can tell: the same labels, or hint line,
 * and one title the end of the other, as a redraw cuts a title from its top.
 */
export const alike = (a: Seen, b: Seen) => a.form === b.form && (a.title.endsWith(b.title) || b.title.endsWith(a.title))

// At most this many non-blank lines below a list's last item (design §6.3).
const BELOW = 10
// A title is at most this many lines.
const TITLE = 3
// A hint line wraps onto at most this many lines.
const HINT_ROWS = 3
// A window with only a hint line ends it among the last this many non-blank lines.
const LAST = 3

const ITEM = /^(\s*)(❯\s+)?(\d{1,2})\.\s+(\S.*)$/
const ENDS = '─╭╮╰╯┌┐└┘├┤'
const TAB = /^[←☐☒☑✔◯]/
// A list cut short: how many items more, or ↑ and ↓ where the cursor goes
const CUT = /^\s*(?:…\s*\+\d+\s|[↑↓]\s+\d{1,2}\.\s)/

/**
 * Each line's letters: a box drawn from the middle of the screen (a
 * question's preview) is blanked first, so its insides cannot read as items,
 * and a frame at either end of a line turns to a space, so columns stay.
 */
function prepare(lines: string[][]): string[] {
  const g = lines.map((l) => [...l])
  const tops: [number, number][] = []
  g.forEach((l, y) => l.forEach((c, x) => c === '┌' && x > 0 && tops.push([y, x])))
  tops.sort((a, b) => a[1] - b[1] || a[0] - b[0])
  for (const [y, x] of tops) {
    if (g[y][x] !== '┌' || g[y][x - 1] !== ' ') continue
    let end = -1
    for (let v = y + 1; v < g.length && end < 0; v++) if (g[v][x] === '└') end = v
    if (end < 0) continue
    for (let v = y; v <= end; v++) for (let u = x; u < g[v].length; u++) g[v][u] = ' '
  }
  return g.map((l) => {
    const lit = (c: string) => c !== ' ' && c !== ''
    const a = l.findIndex(lit)
    let b = l.length - 1
    while (b >= 0 && !lit(l[b])) b--
    if (a >= 0 && l[a] === '│') l[a] = ' '
    if (b >= 0 && l[b] === '│') l[b] = ' '
    return l.join('').trimEnd()
  })
}

const indent = (t: string) => t.length - t.trimStart().length

export function isRule(t: string, cols: number): boolean {
  const s = t.trim()
  if (!s || !ENDS.includes(s[0]) || !ENDS.includes(s[s.length - 1])) return false
  const dashes = [...s].filter((c) => c === '─').length
  // The rule over the input box holds the session's name, if it has one: on a
  // narrow screen its dashes are fewer than half the width, though still most
  // of its own letters.
  return dashes >= 20 && (dashes >= cols / 2 || dashes * 2 >= [...s].length)
}

/** The rule of ▔ that Claude Code draws over a window filling the screen's width. */
function isTop(t: string, cols: number): boolean {
  const s = t.trim()
  return s.length >= 20 && s.length >= cols / 2 && /^▔+$/.test(s)
}

/** The input box: a rule, a line that starts with ❯, and the next rule below. */
export function inputBox(texts: string[], cols: number): [number, number] | null {
  for (let i = texts.length - 2; i >= 0; i--) {
    if (!isRule(texts[i], cols) || !texts[i + 1].startsWith('❯')) continue
    for (let j = i + 2; j < texts.length; j++) if (isRule(texts[j], cols)) return [i, j]
  }
  return null
}

interface Item {
  i: number
  n: number
  /** The column of the number's first digit, and of its dot. */
  col: number
  dot: number
  cursor: boolean
  text: string
}

function itemAt(texts: string[], i: number): Item | null {
  const m = ITEM.exec(texts[i])
  if (!m) return null
  const col = m[1].length + (m[2]?.length ?? 0)
  return { i, n: Number(m[3]), col, dot: col + m[3].length, cursor: !!m[2], text: m[4] }
}

/**
 * The list that ends at the bottom-most numbered line: its numbers run up
 * to 1 in the same column, with only blank lines and deeper lines between.
 */
function items(texts: string[]): Item[] | null {
  let at = texts.length - 1
  while (at >= 0 && !itemAt(texts, at)) at--
  if (at < 0) return null
  let below = itemAt(texts, at)!
  const got = [below]
  for (let i = at - 1; i >= 0 && below.n > 1; i--) {
    if (!texts[i].trim()) continue
    const it = itemAt(texts, i)
    if (it && it.n === below.n - 1 && (it.col === below.col || it.dot === below.dot)) {
      got.unshift(it)
      below = it
    } else if (indent(texts[i]) <= below.col) return null
  }
  return below.n === 1 ? got : null
}

interface HintBlock {
  s: number
  e: number
  parts: HintPart[]
  text: string
}

/** A hint line wrapped onto several rows, as one line. */
function joined(rows: string[]): string {
  let acc = rows[0].trim()
  for (const r of rows.slice(1)) {
    const t = r.trim()
    // two hint lines stacked, or one wrapped in the middle of a part
    acc += hintLine(acc) && hintLine(t) && !acc.endsWith('·') ? ` · ${t}` : ` ${t}`
  }
  return acc
}

/** The bottom-most hint line that starts at lo or below and ends at from or below. */
function hintAt(texts: string[], lo: number, from: number): HintBlock | null {
  for (let e = texts.length - 1; e >= from; e--) {
    if (!texts[e].trim()) continue
    for (let n = HINT_ROWS; n >= 1; n--) {
      const s = e - n + 1
      if (s < lo) continue
      const rows = texts.slice(s, e + 1)
      if (rows.some((t) => !t.trim())) continue
      const text = joined(rows)
      const parts = hintLine(text)
      if (parts) return { s, e, parts, text }
    }
  }
  return null
}

function marked(label: string): [Option['mark'], string] {
  let m = /^(?:\[ \]|☐)\s*/.exec(label)
  if (m) return ['off', label.slice(m[0].length)]
  m = /^(?:\[[x✔✓]\]|[☑☒])\s*/i.exec(label)
  if (m) return ['on', label.slice(m[0].length)]
  if (/\s*✔$/.test(label)) return ['current', label.replace(/\s*✔$/, '')]
  return ['', label]
}

/** An item: what follows a wide gap on its line, and its deeper lines below, are its description. */
function option(it: Item, texts: string[], end: number): Option {
  const [head, ...rest] = it.text.split(/\s{2,}/)
  const [mark, label] = marked(head)
  const desc = rest.length ? [rest.join(' ')] : []
  for (let i = it.i + 1; i < end; i++) {
    const t = texts[i]
    if (!t.trim() || indent(t) <= it.col || ITEM.test(t) || t.trim().startsWith('Notes:')) break
    desc.push(t.trim())
  }
  return { n: it.n, label: label.trim(), desc: desc.join(' '), mark }
}

/** The lines just above the first item, up to a blank line, a rule or a tab line. */
function titleAt(texts: string[], first: number, cols: number): { text: string; top: number } {
  let i = first - 1
  while (i >= 0 && !texts[i].trim()) i--
  const got: string[] = []
  let top = first
  for (; i >= 0 && got.length < TITLE; i--) {
    const t = texts[i].trim()
    if (!t || isRule(texts[i], cols) || isTop(texts[i], cols) || TAB.test(t)) break
    got.unshift(t.replace(/[│╭╮╰╯─]/g, '').trim())
    top = i
  }
  const text = got.filter(Boolean).join(' ')
  return { text, top: text ? top : first }
}

/** Lines as text to copy: no blank lines around them, no indent they share. */
function clean(ls: string[]): string {
  let a = 0
  let b = ls.length
  while (a < b && !ls[a].trim()) a++
  while (b > a && !ls[b - 1].trim()) b--
  const kept = ls.slice(a, b)
  if (!kept.length) return ''
  const cut = Math.min(...kept.filter((l) => l.trim()).map(indent))
  return kept.map((l) => l.slice(Math.min(cut, indent(l))).trimEnd()).join('\n')
}

function fnv(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16)
}

function make(id: string, form: string, title: string, options: Option[], cursor: number, texts: string[], top: number, h: HintBlock): Seen {
  const drawn = texts.slice(top, h.s)
  return {
    id,
    form,
    sig: fnv(texts.slice(top, h.e + 1).join('\n')),
    title,
    options,
    cursor,
    hints: readHints(h.parts),
    body: clean(texts.slice(top, h.s)),
    rows: h.e - top + 1,
    partial: drawn.some((t) => CUT.test(t)),
  }
}

function listed(texts: string[], cols: number, box: [number, number] | null): Seen | null {
  const list = items(texts)
  if (!list || list.length < 2) return null
  const first = list[0].i
  const last = list[list.length - 1].i
  // Claude's answer above the box, or a list typed into it
  if (box && box[1] >= first) return null
  if (texts.slice(last + 1).filter((t) => t.trim()).length > BELOW) return null
  const h = hintAt(texts, last + 1, last + 1)
  if (!h) return null
  const cursors = list.filter((it) => it.cursor)
  if (cursors.length > 1) return null
  // no item under the cursor: it stands on a row without a number below them, as a question's "Chat about this"
  if (!cursors.length && texts.slice(last + 1, h.s).filter((t) => t.trimStart().startsWith('❯')).length !== 1) return null
  const options = list.map((it) => option(it, texts, h.s))
  const title = titleAt(texts, first, cols)
  const labels = options.map((o) => o.label).join('\0')
  return make(fnv(title.text + '\0' + labels), fnv('list\0' + labels), title.text, options, cursors[0]?.n ?? 0, texts, title.top, h)
}

/** A window with no list it can read: a hint line near the bottom, under a rule, with no input box. */
function hinted(texts: string[], cols: number, box: [number, number] | null): Seen | null {
  if (box) return null
  const lit = texts.flatMap((t, i) => (t.trim() ? [i] : []))
  if (!lit.length) return null
  const h = hintAt(texts, 0, lit[Math.max(0, lit.length - LAST)])
  if (!h) return null
  let r = h.s - 1
  while (r >= 0 && !isRule(texts[r], cols) && !isTop(texts[r], cols)) r--
  if (r < 0) return null
  return make(fnv(h.text), fnv('hint\0' + h.text), '', [], 0, texts, r + 1, h)
}

// a shot is read once, though the picker panel and the band both look at it
const looks = new WeakMap<Shot, Look>()

/** What the bottom of the screen shows: a window to answer, and the input box. */
export function look(shot: Shot): Look {
  const known = looks.get(shot)
  if (known) return known
  const texts = prepare(shot.lines)
  const b = inputBox(texts, shot.cols)
  const box = b ? { top: shot.top + b[0], rows: b[1] - b[0] + 1 } : null
  const l = { seen: listed(texts, shot.cols, b) ?? hinted(texts, shot.cols, b), box }
  looks.set(shot, l)
  return l
}
