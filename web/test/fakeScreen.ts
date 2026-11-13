// A Screen the tests read: what was written to it, its size and its
// settings. A test types into it as a person would.

import type { ITheme } from '@xterm/xterm'
import type { Shot } from '../src/lib/shot'
import type { Screen } from '../src/lib/xterm'
import { toCells } from './cells'
import type { Ink } from './screens'

const dec = new TextDecoder()

export class FakeScreen implements Screen {
  /** Every screen made since the last reset, oldest first. */
  static all: FakeScreen[] = []
  cols = 80
  rows = 24
  /** Everything written since the last reset. */
  text = ''
  resets = 0
  input = true
  app = false
  theme: ITheme | null = null
  focused = 0
  /** How many shots were built: one a change, however many read it. */
  builds = 0

  /** What a person selected on the screen. */
  selected = ''
  takeSelection(): string {
    const s = this.selected
    this.selected = ''
    return s
  }
  selection(): string {
    return this.selected
  }
  selectAll(): void {
    this.selected = this.text
  }
  /** Reaches the program as typing does, while keys do. */
  paste(text: string): void {
    if (this.input) for (const fn of this.data) fn(text)
  }

  /** Whether a touch on the screen may bring up the device's keyboard. */
  keyboard = true
  /** How often the screen was moved to its end. */
  bottoms = 0
  /** Whether the end of the output is on screen. */
  end = true
  /** The letters' size since setFontSize, null before. */
  fontSize: number | null = null
  disposed = false
  cellSize: [number, number] = [8, 17]
  /** What the screen shows, bottom-aligned, as show() put it. */
  shown: string[] = []
  kind: Shot['kind'] = 'normal'
  /** The colours of what show() put, by the row of its text; the default colour without them. */
  private ink: Ink | undefined
  private from = 0
  private readonly data = new Set<(s: string) => void>()
  private readonly bin = new Set<(s: string) => void>()
  private readonly views = new Set<(wrote: boolean) => void>()

  constructor() {
    FakeScreen.all.push(this)
  }

  static reset(): void {
    FakeScreen.all = []
  }

  static last(): FakeScreen {
    const s = FakeScreen.all.at(-1)
    if (!s) throw new Error('no screen was made')
    return s
  }

  write(d: string | Uint8Array): void {
    this.text += typeof d === 'string' ? d : dec.decode(d)
    this.tell(true)
  }

  reset(): void {
    this.resets++
    this.text = ''
    this.end = true
    this.tell(false)
  }

  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    this.gen++
  }

  cell(): [number, number] {
    return this.cellSize
  }

  appCursor(): boolean {
    return this.app
  }

  setTheme(t: ITheme): void {
    this.theme = t
  }

  setInput(on: boolean): void {
    this.input = on
  }

  /** Whether the wheel goes as Claude Code counts it. */
  pacedWheel = false
  setPacedWheel(on: boolean): void {
    this.pacedWheel = on
  }

  setKeyboard(on: boolean): void {
    this.keyboard = on
  }

  focus(): void {
    this.focused++
  }

  scrollToBottom(): void {
    this.bottoms++
    this.end = true
    this.tell(false)
  }

  atEnd(): boolean {
    return this.end
  }

  onView(fn: (wrote: boolean) => void): () => void {
    this.views.add(fn)
    return () => {
      this.views.delete(fn)
    }
  }

  async setFontSize(px: number): Promise<boolean> {
    if (px === this.fontSize) return false
    // cells grow with the letters
    const [w, h] = this.cellSize
    const was = this.fontSize ?? px
    this.cellSize = [(w * px) / was, (h * px) / was]
    this.fontSize = px
    return true
  }

  onData(fn: (s: string) => void): () => void {
    this.data.add(fn)
    return () => {
      this.data.delete(fn)
    }
  }

  onBinary(fn: (s: string) => void): () => void {
    this.bin.add(fn)
    return () => {
      this.bin.delete(fn)
    }
  }

  dispose(): void {
    this.disposed = true
  }

  /** The program draws text: its lines sit at the bottom of the screen. */
  show(text: string, kind: Shot['kind'] = 'alternate', ink?: Ink): void {
    const all = text.replace(/\n$/, '').split('\n')
    const lines = all.slice(-this.rows)
    this.shown = [...Array<string>(this.rows - lines.length).fill(''), ...lines]
    this.kind = kind
    this.ink = ink
    // the screen row of the text's first line, which may sit above the screen
    this.from = this.rows - all.length
    this.tell(true)
  }

  private gen = 0
  private last: { gen: number; n: number; shot: Shot } | null = null

  shot(n: number): Shot {
    if (this.last && this.last.gen === this.gen && this.last.n === n) return this.last.shot
    this.builds++
    const shot = this.build(n)
    this.last = { gen: this.gen, n, shot }
    return shot
  }

  private build(n: number): Shot {
    const lines = this.shown.length ? this.shown : Array<string>(this.rows).fill('')
    const top = this.rows - Math.min(n, this.rows)
    const last = lines.slice(top)
    const cells = last.map((l) => toCells(l, this.cols))
    const ink = cells.map((l, i) => l.map((_, x) => (this.ink && top + i >= this.from ? this.ink(top + i - this.from, x) : '')))
    return { kind: this.kind, top, cols: this.cols, lines: cells, ink, view: 0 }
  }

  /** A person types s. */
  type(s: string): void {
    if (this.input) for (const fn of this.data) fn(s)
  }

  /** The terminal reports bytes, as for a mouse in X10 mode. */
  typeBinary(s: string): void {
    for (const fn of this.bin) fn(s)
  }

  /** A person scrolls back through the output, or down to its end. */
  scrollTo(end: boolean): void {
    this.end = end
    this.tell(false)
  }

  private tell(wrote: boolean): void {
    this.gen++
    for (const fn of this.views) fn(wrote)
  }
}
