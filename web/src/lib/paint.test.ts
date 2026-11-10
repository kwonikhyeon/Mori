import { describe, expect, it } from 'vitest'
import { paintFilter } from './paint'

const enc = new TextEncoder()
const dec = new TextDecoder()

// hc's first paint as it came at 40×10 with five history lines (spec §3 #177)
const HEAD = '\x18\x1b[!p\x1b[?2026l\x1b[?1000l\x1b[?2004l\x1b[?1049l\x1b[H\x1b[2J'
const HISTORY = '48\r\n49\r\n50\r\n51\r\n52\x1b[0m\r\n'
const SCREEN = '\x1b[H\x1b[2J\x1b[?1h\x1b[?2004h\x1b[3g\x1b[9G\x1bH\x1b[H53\r\n54\r\n\x1b[0m\x1b[48;5;4m ~ \x1b[0m '
const paint = (feeds: number) => HEAD + HISTORY + '\n'.repeat(feeds) + SCREEN

function run(rows: number, ...chunks: string[]): string {
  const f = paintFilter(rows)
  return chunks.map((c) => dec.decode(f(enc.encode(c)))).join('')
}

describe('paintFilter', () => {
  it('drops the line feed that pushed a blank line in after the history', () => {
    expect(run(10, paint(10))).toBe(paint(9))
  })

  it('does so wherever the paint is split', () => {
    const p = paint(10)
    for (let i = 0; i <= p.length; i++) expect(run(10, p.slice(0, i), p.slice(i)), `split at ${i}`).toBe(paint(9))
    expect(run(10, ...p)).toBe(paint(9))
  })

  it('leaves a paint without history as it came', () => {
    const p = HEAD + '\x1b[?1h\x1b[?2004h\x1b[3g\x1b[H1\r\n2\r\n\n\n$ '
    expect(run(10, p)).toBe(p)
  })

  it('leaves line feeds that are not as many as the rows', () => {
    expect(run(10, paint(9))).toBe(paint(9))
    expect(run(10, paint(11))).toBe(paint(11))
  })

  it('leaves line feeds that no clear follows', () => {
    const p = HEAD + HISTORY + '\n'.repeat(10) + '\x1b[H53'
    expect(run(10, p)).toBe(p)
  })

  it('stops at history it does not know, such as a link', () => {
    const link = '\x1b]8;;https://desk.example.ts.net/\x1b\\desk\x1b]8;;\x1b\\\r\n'
    const p = HEAD + link + HISTORY + '\n'.repeat(10) + SCREEN
    expect(run(10, p)).toBe(p)
  })

  it('touches only the first paint', () => {
    const later = '$ clear\r\n' + HISTORY + '\n'.repeat(10) + SCREEN
    expect(run(10, paint(10), later)).toBe(paint(9) + later)
  })

  it('gives up on output that does not start with a clear', () => {
    const p = 'x'.repeat(5000) + paint(10)
    expect(run(10, p)).toBe(p)
  })
})
