// Screens made by hand for the window reader (pickers design §6.3): each file
// in screens/ is what the bottom of a terminal shows, one line a row, with no
// text from a real conversation. They are 80 cells wide; narrow-40 is 40.
// Vitest keeps this module, the list of files with it, in its module cache
// (node_modules/.vitest-cache): a new file shows after `npx vitest --clearCache`.

import type { Shot } from '../src/lib/shot'
import { toCells } from './cells'

const files = import.meta.glob<string>('./screens/*.txt', { query: '?raw', import: 'default', eager: true })

/** The samples by name: 'model' is screens/model.txt. */
export const SCREENS: Record<string, string> = Object.fromEntries(
  Object.entries(files).map(([path, text]) => [path.replace(/^.*\//, '').replace(/\.txt$/, ''), text]),
)

/** The question with its cursor on the row without a number, "Chat about this". */
export const CHAT = SCREENS['ask-preview'].replace('❯ 1. 파란 하늘색', '  1. 파란 하늘색').replace('\n  Chat about this', '\n❯ Chat about this')

const rows = (text: string) => text.replace(/\n$/, '').split('\n')

/** A cell's colour by its row and column, as Shot.ink says it; the default colour without one. */
export type Ink = (row: number, col: number) => string

/** A sample as the shot of a screen that shows just it. */
export function toShot(text: string, cols = 80, kind: Shot['kind'] = 'alternate', ink?: Ink): Shot {
  const lines = rows(text).map((l) => toCells(l, cols))
  return { kind, top: 0, cols, lines, ink: lines.map((l, y) => l.map((_, x) => ink?.(y, x) ?? '')), view: 0 }
}

const CURSOR = /^\s*❯\s+\d{1,2}\.\s/
const ITEM = /^\s*(?:❯\s+)?(\d{1,2})\.\s/

/**
 * The sample with its cursor on item n instead. What stands before a
 * number is spaces and ❯, one cell each, so a letter's index there is its
 * column.
 */
export function cursorAt(text: string, n: number): string {
  const lines = rows(text)
  const from = lines.findIndex((l) => CURSOR.test(l))
  if (from < 0) throw new Error('no cursor')
  const c = lines[from].indexOf('❯')
  let to = -1
  lines.forEach((l, i) => {
    if (Number(ITEM.exec(l)?.[1]) === n) to = i
  })
  if (to < 0) throw new Error(`no item ${n}`)
  const put = (l: string, ch: string) => l.slice(0, c) + ch + l.slice(c + 1)
  lines[from] = put(lines[from], ' ')
  if (lines[to][c] !== ' ') throw new Error(`no room for the cursor on item ${n}`)
  lines[to] = put(lines[to], '❯')
  return lines.join('\n') + '\n'
}
