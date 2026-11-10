// A Screen the tests read: what was written to it, its size and its
// settings. A test types into it as a person would.

import type { ITheme } from '@xterm/xterm'
import type { Screen } from '../src/lib/xterm'

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
  /** How often the screen was moved to its end. */
  bottoms = 0
  /** Whether the end of the output is on screen. */
  end = true
  /** The letters' size since setFontSize, null before. */
  fontSize: number | null = null
  disposed = false
  cellSize: [number, number] = [8, 17]
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
    for (const fn of this.views) fn(wrote)
  }
}
