// Light, dark or the OS setting (spec §3 #118). The choice lives in
// localStorage; public/theme.js applies it before the first paint and
// initTheme keeps <html data-theme> in step afterwards.
import { computed, effect, signal } from '@preact/signals'
import type { ITheme } from '@xterm/xterm'
import { load, save } from './storage'

export type ThemePref = 'system' | 'light' | 'dark'
export type Mode = 'light' | 'dark'

const KEY = 'mori.theme'
const QUERY = '(prefers-color-scheme: dark)'
// --bg of each mode, for the browser's own chrome.
const CHROME: Record<Mode, string> = { light: '#F6F5F2', dark: '#151412' }

export const theme = signal<ThemePref>('system')
const systemDark = signal(false)
export const effectiveTheme = computed<Mode>(() =>
  theme.value === 'system' ? (systemDark.value ? 'dark' : 'light') : theme.value,
)

const isPref = (v: unknown): v is ThemePref => v === 'system' || v === 'light' || v === 'dark'

/** What each choice is called on the header button and in Settings. */
export const THEME_LABEL: Record<ThemePref, string> = { system: '시스템', light: '밝게', dark: '어둡게' }

export function setTheme(t: ThemePref): void {
  theme.value = t
  save(KEY, t)
}

/** Loads the saved choice and follows the OS. The returned function stops it. */
export function initTheme(): () => void {
  const saved = load<unknown>(KEY, 'system')
  theme.value = isPref(saved) ? saved : 'system'
  const mql = typeof window.matchMedia === 'function' ? window.matchMedia(QUERY) : null
  systemDark.value = !!mql?.matches
  const onChange = (e: { matches: boolean }) => {
    systemDark.value = e.matches
  }
  mql?.addEventListener('change', onChange)
  const stop = effect(() => {
    const root = document.documentElement
    if (theme.value === 'system') delete root.dataset.theme
    else root.dataset.theme = theme.value
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', CHROME[effectiveTheme.value])
  })
  return () => {
    stop()
    mql?.removeEventListener('change', onChange)
  }
}

// The terminal is dark in both modes; only its background follows the page.
const FG = '#ECEAE5'
const TERM_BG: Record<Mode, string> = { light: '#1F1E1C', dark: '#121110' }
const ANSI = {
  black: '#3D3A35',
  red: '#F2647E',
  green: '#8CC265',
  yellow: '#FFB15C',
  blue: '#6F95F5',
  magenta: '#B583E8',
  cyan: '#3DB8A5',
  white: '#D6D2CA',
  brightBlack: '#8C877E',
  brightRed: '#FF8FA3',
  brightGreen: '#A8D98A',
  brightYellow: '#FFC98A',
  brightBlue: '#8FB0FF',
  brightMagenta: '#C99BF0',
  brightCyan: '#5CCFC0',
  brightWhite: '#FFFFFF',
}

export function terminalTheme(mode: Mode): ITheme {
  const bg = TERM_BG[mode]
  return {
    background: bg,
    foreground: FG,
    cursor: FG,
    cursorAccent: bg,
    selectionBackground: 'rgba(143, 176, 255, .32)',
    scrollbarSliderBackground: 'rgba(236, 234, 229, .18)',
    scrollbarSliderHoverBackground: 'rgba(236, 234, 229, .3)',
    scrollbarSliderActiveBackground: 'rgba(236, 234, 229, .4)',
    ...ANSI,
  }
}

export interface DisplayFacts {
  fg: string
  bg: string
  cursor: string
  cell?: [number, number]
}

/** What attach `display` tells the core: the colors it answers OSC 10/11 with and the cell size in CSS pixels. */
export function displayFacts(mode: Mode, cell: [number, number]): DisplayFacts {
  const facts: DisplayFacts = { fg: FG, bg: TERM_BG[mode], cursor: FG }
  const w = Math.round(cell[0])
  const h = Math.round(cell[1])
  if (w > 0 && h > 0) facts.cell = [w, h]
  return facts
}
