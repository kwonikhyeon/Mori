// The status line Claude Code draws under its input box, as parts Mori can
// draw (claude-input design §3.3). The line is the person's own command's,
// so nothing about it is known: a line cut by bars becomes chips, a line
// with a bar of glyphs and a percent becomes a progress bar, and any other
// line stays as it is.

export type StatusPart =
  | { kind: 'chips'; chips: string[] }
  | { kind: 'bar'; name: string; percent: number; rest: string }
  | { kind: 'text'; text: string }

const GLYPHS = /[○●◐◑▮▯■□█░▒▓]+/
const PERCENT = /(\d{1,3})%/

const tidy = (s: string) => s.trim().replace(/\s{2,}/g, ' ')

function part(line: string): StatusPart {
  const g = GLYPHS.exec(line)
  const p = PERCENT.exec(line)
  if (g && p && g.index < p.index) {
    const rest = line.slice(p.index + p[0].length).replace(/^\s*⟳?\s*/, '')
    return { kind: 'bar', name: tidy(line.slice(0, g.index)), percent: Math.min(100, Number(p[1])), rest: tidy(rest) }
  }
  const chips = line.split(/\s*│\s*|\s+\|\s+/).map(tidy).filter(Boolean)
  return chips.length > 1 ? { kind: 'chips', chips } : { kind: 'text', text: tidy(line) }
}

/** The parts of the status line's lines, one a line. */
export function readStatus(lines: string[]): StatusPart[] {
  return lines.map(part)
}
