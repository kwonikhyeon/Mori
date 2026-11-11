import { Unicode11Addon } from '@xterm/addon-unicode11'
import { Terminal } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'
import { shotOf } from './shot'

// A terminal that is never opened: jsdom cannot lay out its cells, but its
// buffer reads as a drawn one does.
function term(cols: number, rows: number): Terminal {
  const t = new Terminal({ cols, rows, allowProposedApi: true })
  t.loadAddon(new Unicode11Addon())
  t.unicode.activeVersion = '11'
  return t
}

const write = (t: Terminal, s: string) => new Promise<void>((r) => t.write(s, r))

describe('shotOf', () => {
  it('reads wide cells as one letter and an empty cell', async () => {
    const t = term(20, 4)
    await write(t, 'a한글❯ 1.')
    const s = shotOf(t, 4)
    expect(s.lines[0].slice(0, 8)).toEqual(['a', '한', '', '글', '', '❯', ' ', '1'])
    for (const l of s.lines) expect(l).toHaveLength(20)
    expect(s.cols).toBe(20)
  })

  it('tells the alternate buffer', async () => {
    const t = term(20, 4)
    await write(t, 'x')
    expect(shotOf(t, 4).kind).toBe('normal')
    await write(t, '\x1b[?1049h')
    expect(shotOf(t, 4).kind).toBe('alternate')
  })

  it('gives the live bottom while scrolled back', async () => {
    const t = term(20, 4)
    await write(t, Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\r\n'))
    t.scrollLines(-10)
    const s = shotOf(t, 2)
    expect(s.lines.map((l) => l.join('').trimEnd())).toEqual(['line 28', 'line 29'])
    expect(s.top).toBe(t.buffer.active.baseY + 2)
  })

  it('gives fewer lines than asked', async () => {
    const t = term(20, 4)
    await write(t, 'one\r\ntwo')
    const s = shotOf(t, 40)
    expect(s.lines).toHaveLength(4)
    expect(s.top).toBe(t.buffer.active.baseY)
    expect(s.lines[1].join('').trimEnd()).toBe('two')
  })
})
