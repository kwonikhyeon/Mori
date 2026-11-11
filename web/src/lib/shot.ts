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
}

/** The last n lines of the live screen, whatever the view is scrolled to. */
export function shotOf(term: Pick<Terminal, 'buffer' | 'rows' | 'cols'>, n: number): Shot {
  const b = term.buffer.active
  const top = b.baseY + Math.max(0, term.rows - n)
  const end = b.baseY + term.rows
  const lines: string[][] = []
  let cell: IBufferCell | undefined
  for (let y = top; y < end; y++) {
    const line = b.getLine(y)
    const cells: string[] = []
    for (let x = 0; x < term.cols; x++) {
      cell = line?.getCell(x, cell)
      if (!cell) cells.push(' ')
      else cells.push(cell.getWidth() === 0 ? '' : cell.getChars() || ' ')
    }
    lines.push(cells)
  }
  return { kind: b.type, top, cols: term.cols, lines }
}
