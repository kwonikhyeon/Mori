// The one place that opens xterm.js; touchscroll.ts lends it a finger.
// Views and tests see a Screen; the view tests replace this module, since
// jsdom cannot lay out cells.

import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { isApple } from './platform'
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
  focus(): void
  /** Shows the end of the output, where the cursor is. */
  scrollToBottom(): void
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
// Nerd Fonts that shell prompts draw their arrows and icons with: one the
// device has fills those in, else they stay boxes.
const FONT = [
  "'JetBrains Mono'",
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
  const term = new Terminal({
    cols: o.cols,
    rows: o.rows,
    fontFamily: FONT,
    fontSize: o.fontSize,
    lineHeight: 1.15,
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
  const cell = (): [number, number] => {
    const s = term.element?.querySelector('.xterm-screen')?.getBoundingClientRect()
    if (!s || !term.cols || !term.rows) return [0, 0]
    return [s.width / term.cols, s.height / term.rows]
  }
  const untouch = touchScroll(el, term, { rowHeight: () => cell()[1] })
  const off = (d: { dispose(): void }) => () => d.dispose()
  return {
    get cols() { return term.cols },
    get rows() { return term.rows },
    write: (d) => term.write(d),
    reset: () => term.reset(),
    resize: (c, r) => {
      if (c !== term.cols || r !== term.rows) term.resize(c, r)
    },
    cell,
    appCursor: () => term.modes.applicationCursorKeysMode,
    setTheme: (t) => {
      term.options.theme = t
    },
    setInput: (on) => {
      term.options.disableStdin = !on
    },
    focus: () => term.focus(),
    scrollToBottom: () => term.scrollToBottom(),
    onData: (fn) => off(term.onData(fn)),
    onBinary: (fn) => off(term.onBinary(fn)),
    dispose: () => {
      untouch()
      term.dispose()
    },
  }
}
