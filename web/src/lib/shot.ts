// What the bottom of a terminal shows, cell by cell (pickers design §6.1).
// A wide letter (Hangul, most emoji) fills its first cell and leaves the
// second one ''; an empty cell is ' '. So a column is a cell, and a line's
// letters are its cells joined. Only the letters are read: the attributes
// (dim, bold) wait for stage 3.

import type { IBufferCell, Terminal } from '@xterm/xterm'

export interface Shot {
  /** Which buffer is up: a full-screen program draws on the alternate one. */
  kind: 'normal' | 'alternate'
  /** The buffer line of lines[0]. */
  top: number
  cols: number
  /** Each line's cells, cols of them. */
  lines: string[][]
  /**
   * Each cell's letter colour, as lines: '' the default, 'rgb:R,G,B', or
   * 'p:N' from the palette; 'inverse' for a cell drawn inverted, as a
   * program draws its own cursor. A wide letter's second cell takes the first's.
   */
  ink: string[][]
  /** The buffer line the view starts at, wherever it is scrolled to. */
  view: number
}

/** A cell's letter colour, as Shot.ink says it. */
export function inkOf(c: IBufferCell): string {
  if (c.isInverse()) return 'inverse'
  if (c.isFgDefault()) return ''
  const v = c.getFgColor()
  return c.isFgRGB() ? `rgb:${(v >> 16) & 255},${(v >> 8) & 255},${v & 255}` : `p:${v}`
}

/**
 * The last n lines of the live screen up to its last written line, whatever
 * the view is scrolled to. A program that draws from the top of a tall screen
 * (Claude Code, fresh or after /clear) leaves the rows below it blank.
 */
export function shotOf(term: Pick<Terminal, 'buffer' | 'rows' | 'cols'>, n: number): Shot {
  const b = term.buffer.active
  let end = b.baseY + term.rows
  while (end > b.baseY + 1 && !b.getLine(end - 1)?.translateToString(true).trim()) end--
  const top = Math.max(b.baseY, end - n)
  const lines: string[][] = []
  const ink: string[][] = []
  let cell: IBufferCell | undefined
  for (let y = top; y < end; y++) {
    const line = b.getLine(y)
    const cells: string[] = []
    const inks: string[] = []
    for (let x = 0; x < term.cols; x++) {
      cell = line?.getCell(x, cell)
      if (!cell) {
        cells.push(' ')
        inks.push('')
      } else if (cell.getWidth() === 0) {
        cells.push('')
        inks.push(inks[x - 1] ?? '')
      } else {
        cells.push(cell.getChars() || ' ')
        inks.push(inkOf(cell))
      }
    }
    lines.push(cells)
    ink.push(inks)
  }
  return { kind: b.type, top, cols: term.cols, lines, ink, view: b.viewportY }
}
