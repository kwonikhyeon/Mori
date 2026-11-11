// The bytes of the quick keys (spec §3 #123). They go down the attach
// stream like typed keys, so they reach the program without a delay. A
// phone keyboard has no Ctrl or Alt: the quick keys hold them for the next
// key, or until tapped off (spec §3 #186).

export type QuickKey = 'esc' | 'tab' | 'shift-tab' | 'enter' | 'ctrl-c' | 'up' | 'down' | 'left' | 'right'

/** A modifier the quick keys hold. */
export type Mod = 'ctrl' | 'alt'

/** Off, on for the next key, or on until tapped again. */
export type ModState = 'off' | 'once' | 'lock'

export type Mods = Record<Mod, ModState>

export const NO_MODS: Mods = { ctrl: 'off', alt: 'off' }

/** A second tap within this long holds the modifier. */
export const LOCK_MS = 400

const ARROWS: Partial<Record<QuickKey, string>> = { up: 'A', down: 'B', right: 'C', left: 'D' }

const PLAIN: Partial<Record<QuickKey, string>> = {
  esc: '\x1b',
  tab: '\t',
  'shift-tab': '\x1b[Z',
  enter: '\r',
  'ctrl-c': '\x03',
}

// Ctrl with a key that is not a letter, as xterm sends it. Ctrl with the
// Backspace deletes the word before the cursor (Ctrl+W): a terminal's own
// Ctrl+Backspace is the Backspace again.
const CTRL: Record<string, string> = {
  ' ': '\x00',
  '@': '\x00',
  '[': '\x1b',
  '\\': '\x1c',
  ']': '\x1d',
  '^': '\x1e',
  _: '\x1f',
  '?': '\x7f',
  '\x7f': '\x17',
}

/** The next state of a modifier tapped since ms after its last tap. */
export function tapMod(s: ModState, since: number): ModState {
  if (s === 'off') return 'once'
  if (s === 'once' && since < LOCK_MS) return 'lock'
  return 'off'
}

/**
 * One key typed with Ctrl, Alt or both held: Ctrl makes a letter its control
 * character, Alt puts ESC before it (Alt+Enter is ESC CR). What is not one
 * key (a syllable the IME puts in, a paste, a key's escape sequence) goes as
 * it is.
 */
export function withMods(data: string, ctrl: boolean, alt: boolean): string {
  if (data.length !== 1) return data
  let s = data
  if (ctrl) {
    const c = s.charCodeAt(0)
    if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) s = String.fromCharCode(c & 0x1f)
    else s = CTRL[s] ?? s
  }
  if (alt && s.charCodeAt(0) < 0x80) s = '\x1b' + s
  return s
}

/** A quick key's bytes, the way the program reads them now, with the modifiers held. */
export function keyBytes(k: QuickKey, appCursor: boolean, ctrl = false, alt = false): string {
  const arrow = ARROWS[k]
  if (arrow) {
    // A modified arrow always takes the CSI form: 1;3 is Alt, 1;5 Ctrl, 1;7 both.
    const m = 1 + (alt ? 2 : 0) + (ctrl ? 4 : 0)
    if (m > 1) return `\x1b[1;${m}${arrow}`
    return (appCursor ? '\x1bO' : '\x1b[') + arrow
  }
  return withMods(PLAIN[k] ?? '', ctrl, alt)
}

// The keys the core names that are one byte or one sequence.
const NAMED: Record<string, string> = { enter: '\r', return: '\r', esc: '\x1b', escape: '\x1b', tab: '\t', space: ' ', backspace: '\x7f' }

/**
 * The bytes of a key named the way the core takes it ('up', 'shift+tab',
 * 'ctrl+e', '2'), for the attach stream. Null for a key it has no bytes
 * for here (a function key, PageUp): that one goes through the core.
 */
export function namedBytes(name: string, appCursor: boolean): string | null {
  if ([...name].length === 1) return name
  const mods = name.split('+')
  const base = mods.pop()!
  let ctrl = false
  let alt = false
  let shift = false
  for (const m of mods) {
    if (m === 'ctrl') ctrl = true
    else if (m === 'alt') alt = true
    else if (m === 'shift') shift = true
    else return null
  }
  const arrow = ARROWS[base as QuickKey]
  if (arrow) {
    if (!shift) return keyBytes(base as QuickKey, appCursor, ctrl, alt)
    return `\x1b[1;${2 + (alt ? 2 : 0) + (ctrl ? 4 : 0)}${arrow}`
  }
  if (shift) return base === 'tab' && !ctrl && !alt ? '\x1b[Z' : null
  const b = NAMED[base] ?? ([...base].length === 1 ? base : null)
  return b === null ? null : withMods(b, ctrl, alt)
}

export interface QuickKeyInfo {
  key: QuickKey | Mod
  /** What the key shows. */
  text: string
  /** What a screen reader says, when the text is a symbol. */
  label: string
}

export const isMod = (k: QuickKey | Mod): k is Mod => k === 'ctrl' || k === 'alt'

export const QUICK_KEYS: QuickKeyInfo[] = [
  { key: 'esc', text: 'Esc', label: 'Esc' },
  { key: 'ctrl', text: 'Ctrl', label: 'Ctrl' },
  { key: 'alt', text: 'Alt', label: 'Alt' },
  { key: 'tab', text: 'Tab', label: 'Tab' },
  { key: 'shift-tab', text: '⇧Tab', label: 'Shift+Tab' },
  { key: 'up', text: '↑', label: '위 화살표' },
  { key: 'down', text: '↓', label: '아래 화살표' },
  { key: 'left', text: '←', label: '왼쪽 화살표' },
  { key: 'right', text: '→', label: '오른쪽 화살표' },
  { key: 'enter', text: 'Enter', label: 'Enter' },
  { key: 'ctrl-c', text: '⌃C', label: 'Ctrl+C' },
]

const STRAY_ARROWS: Record<string, QuickKey> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }

/** What a key down means to the terminal when it was pressed outside it. */
export interface StrayKey {
  key: string
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
  isComposing: boolean
  keyCode: number
}

/**
 * The bytes of a key pressed while the focus is not in the terminal (spec §3
 * #188): a letter, Enter, Backspace or an arrow. Null for the rest, for a key
 * with Ctrl, Alt or ⌘, and while the IME composes. Escape closes what is
 * open on the page: sent by mistake, it would stop the program's work.
 */
export function strayBytes(e: StrayKey, appCursor: boolean): string | null {
  if (e.isComposing || e.keyCode === 229 || e.ctrlKey || e.altKey || e.metaKey) return null
  // a letter, a digit, a sign or the space: one character, or one emoji
  if ([...e.key].length === 1) return e.key
  const arrow = STRAY_ARROWS[e.key]
  if (arrow) return keyBytes(arrow, appCursor)
  if (e.key === 'Enter') return '\r'
  if (e.key === 'Backspace') return '\x7f'
  return null
}
