// A line of text as the cells a terminal draws it in, for screens made by
// hand. The widths are Unicode 11's for the letters the samples use: Hangul,
// CJK and fullwidth forms, and the common emoji take two cells.

const WIDE: [number, number][] = [
  [0x1100, 0x115f],
  [0x2705, 0x2705],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
]

export function cellWidth(cp: number): 1 | 2 {
  return WIDE.some(([a, b]) => cp >= a && cp <= b) ? 2 : 1
}

/** text in cols cells: a wide letter, then '', and ' ' to the end. */
export function toCells(text: string, cols: number): string[] {
  const cells: string[] = []
  for (const ch of text) {
    cells.push(ch)
    if (cellWidth(ch.codePointAt(0)!) === 2) cells.push('')
  }
  if (cells.length > cols) throw new Error(`${cells.length} cells in ${cols}: ${text}`)
  while (cells.length < cols) cells.push(' ')
  return cells
}
