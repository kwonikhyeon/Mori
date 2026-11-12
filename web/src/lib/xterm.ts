// The one place that opens xterm.js; touchscroll.ts lends it a finger.
// Views and tests see a Screen; the view tests replace this module, since
// jsdom cannot lay out cells.

import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { isApple } from './platform'
import { LINE_HEIGHT, POWERLINE, followPixelRatio, loadPowerline } from './powerline'
import { shotOf, type Shot } from './shot'
import { touchScroll } from './touchscroll'

export interface Screen {
  readonly cols: number
  readonly rows: number
  write(d: string | Uint8Array): void
  reset(): void
  resize(cols: number, rows: number): void
  /** The size of one cell in CSS pixels, [0, 0] before the first render. */
  cell(): [number, number]
  /** Whether the program asked for application cursor keys (DECCKM). */
  appCursor(): boolean
  setTheme(t: ITheme): void
  /** Whether keys typed into the screen reach the program. */
  setInput(on: boolean): void
  /**
   * Whether a touch on the screen may bring up the device's keyboard. xterm
   * takes a touch's focus itself; off, its field asks for no keyboard
   * (inputmode="none"), so the view, and the terminal, keep their size.
   */
  setKeyboard(on: boolean): void
  /** What is selected on the screen, '' for nothing; the selection is cleared. */
  takeSelection(): string
  /** What is selected on the screen, '' for nothing; the selection stays. */
  selection(): string
  selectAll(): void
  /** Types text as a paste: marked as one when the program asked (bracketed paste). */
  paste(text: string): void
  focus(): void
  /** Shows the end of the output, where the cursor is. */
  scrollToBottom(): void
  /** Whether the end of the output is on screen. */
  atEnd(): boolean
  /**
   * Calls fn when the view may have moved: a scroll, a reset, or new output
   * (wrote). Returns the function that stops it.
   */
  onView(fn: (wrote: boolean) => void): () => void
  /** The last n lines of the live screen, cell by cell, wherever the view is. */
  shot(n: number): Shot
  /** Draws with letters of px CSS pixels; resolves true once it changed. */
  setFontSize(px: number): Promise<boolean>
  onData(fn: (s: string) => void): () => void
  onBinary(fn: (s: string) => void): () => void
  dispose(): void
}

export interface ScreenOptions {
  fontSize: number
  theme: ITheme
  cols: number
  rows: number
}

// The stack of --font-mono: JetBrains Mono for Latin, the system's
// monospace and Hangul fonts for the rest (spec §3 #117). Between them, the
// Powerline font made for the terminal's rows, which draws a prompt's arrows
// and branch on every device (spec §3 #176), and the Nerd Fonts for the
// other icons a prompt may use: one the device has fills those in, else they
// stay boxes.
const FONT = [
  "'JetBrains Mono'",
  `'${POWERLINE}'`,
  "'Symbols Nerd Font Mono'",
  "'Symbols Nerd Font'",
  "'MesloLGS NF'",
  "'JetBrainsMono Nerd Font Mono'",
  "'JetBrainsMono Nerd Font'",
  "'Hack Nerd Font Mono'",
  "'FiraCode Nerd Font Mono'",
  "'CaskaydiaCove Nerd Font Mono'",
  "'D2CodingLigature Nerd Font Mono'",
  "ui-monospace, 'SF Mono', Menlo, Consolas, 'D2Coding', 'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans KR', monospace",
].join(', ')

// xterm measures its cells once: wait for the web font, but not for long.
async function fontsReady(size: number): Promise<void> {
  try {
    await Promise.race([
      Promise.all([
        document.fonts.load(`400 ${size}px "JetBrains Mono"`),
        document.fonts.load(`700 ${size}px "JetBrains Mono"`),
      ]),
      new Promise((r) => setTimeout(r, 1500)),
    ])
  } catch {
    // the fallback fonts measure as well
  }
}

function openLink(_e: MouseEvent, uri: string): void {
  window.open(uri, '_blank', 'noopener,noreferrer')
}

export async function openScreen(el: HTMLElement, o: ScreenOptions): Promise<Screen> {
  await fontsReady(o.fontSize)
  // before the terminal measures its glyphs' widths
  await loadPowerline(FONT, o.fontSize)
  const term = new Terminal({
    cols: o.cols,
    rows: o.rows,
    fontFamily: FONT,
    fontSize: o.fontSize,
    lineHeight: LINE_HEIGHT,
    theme: o.theme,
    scrollback: 5000,
    cursorBlink: false,
    allowProposedApi: true,
  })
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'
  term.loadAddon(new WebLinksAddon(openLink))
  // On Windows and Linux Ctrl+C copies a selection, else it interrupts;
  // Ctrl+V is the browser's paste. A Mac has ⌘C and ⌘V for these.
  if (!isApple()) {
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return true
      const k = e.key.toLowerCase()
      if (k === 'c' && term.hasSelection()) {
        void navigator.clipboard?.writeText(term.getSelection()).catch(() => {})
        term.clearSelection()
        return false
      }
      return k !== 'v'
    })
  }
  term.open(el)
  let size = o.fontSize
  let gone = false
  const views = new Set<(wrote: boolean) => void>()
  // what the screen shows changes with each notice and resize: a shot is built once between
  let gen = 0
  let last: { gen: number; n: number; shot: Shot } | null = null
  const tell = (wrote: boolean) => {
    gen++
    for (const fn of views) fn(wrote)
  }
  // A wheel, a finger (touchscroll.ts) and the scrollbar scroll through
  // scrollLines, which tells onScroll as new lines do; a write tells once
  // its bytes are parsed.
  const offScroll = term.onScroll(() => tell(false))
  const offWrite = term.onWriteParsed(() => tell(true))
  const cell = (): [number, number] => {
    const s = term.element?.querySelector('.xterm-screen')?.getBoundingClientRect()
    if (!s || !term.cols || !term.rows) return [0, 0]
    return [s.width / term.cols, s.height / term.rows]
  }
  const untouch = touchScroll(el, term, { rowHeight: () => cell()[1] })
  // a zoom or another screen changes the rows' height in device pixels
  const unfollow = followPixelRatio(() => void loadPowerline(FONT, size))
  const off = (d: { dispose(): void }) => () => d.dispose()
  return {
    get cols() { return term.cols },
    get rows() { return term.rows },
    write: (d) => term.write(d),
    reset: () => {
      term.reset()
      tell(false)
    },
    resize: (c, r) => {
      if (c !== term.cols || r !== term.rows) {
        term.resize(c, r)
        gen++
      }
    },
    cell,
    appCursor: () => term.modes.applicationCursorKeysMode,
    setTheme: (t) => {
      term.options.theme = t
    },
    takeSelection: () => {
      const s = term.hasSelection() ? term.getSelection() : ''
      term.clearSelection()
      return s
    },
    selection: () => (term.hasSelection() ? term.getSelection() : ''),
    selectAll: () => term.selectAll(),
    paste: (text) => term.paste(text),
    setKeyboard: (on) => {
      if (on) term.textarea?.removeAttribute('inputmode')
      else term.textarea?.setAttribute('inputmode', 'none')
    },
    setInput: (on) => {
      term.options.disableStdin = !on
    },
    focus: () => term.focus(),
    scrollToBottom: () => {
      term.scrollToBottom()
      tell(false)
    },
    atEnd: () => {
      const b = term.buffer.active
      return b.viewportY >= b.baseY
    },
    onView: (fn) => {
      views.add(fn)
      return () => {
        views.delete(fn)
      }
    },
    shot: (n) => {
      if (last && last.gen === gen && last.n === n) return last.shot
      const shot = shotOf(term, n)
      last = { gen, n, shot }
      return shot
    },
    setFontSize: async (px) => {
      if (px === size || gone) return false
      size = px
      await fontsReady(px)
      // the Powerline face is made for the rows' height
      await loadPowerline(FONT, px)
      if (size !== px || gone) return false
      term.options.fontSize = px
      return true
    },
    onData: (fn) => off(term.onData(fn)),
    onBinary: (fn) => off(term.onBinary(fn)),
    dispose: () => {
      gone = true
      views.clear()
      offScroll.dispose()
      offWrite.dispose()
      unfollow()
      untouch()
      term.dispose()
    },
  }
}
