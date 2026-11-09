// The bytes of the quick keys (spec §3 #123). They go down the attach
// stream like typed keys, so they reach the program without a delay.

export type QuickKey = 'esc' | 'tab' | 'shift-tab' | 'enter' | 'ctrl-c' | 'up' | 'down' | 'left' | 'right'

const ARROWS: Partial<Record<QuickKey, string>> = { up: 'A', down: 'B', right: 'C', left: 'D' }

const PLAIN: Partial<Record<QuickKey, string>> = {
  esc: '\x1b',
  tab: '\t',
  'shift-tab': '\x1b[Z',
  enter: '\r',
  'ctrl-c': '\x03',
}

/** The bytes of k. appCursor is the program's DECCKM: arrows are SS3 then. */
export function keyBytes(k: QuickKey, appCursor: boolean): string {
  const arrow = ARROWS[k]
  if (arrow) return (appCursor ? '\x1bO' : '\x1b[') + arrow
  return PLAIN[k] ?? ''
}

export interface QuickKeyInfo {
  key: QuickKey
  /** What the button shows. */
  text: string
  /** What a screen reader says. */
  label: string
}

/** The row under the phone terminal, in its order. */
export const QUICK_KEYS: QuickKeyInfo[] = [
  { key: 'esc', text: 'Esc', label: 'Esc' },
  { key: 'tab', text: 'Tab', label: 'Tab' },
  { key: 'shift-tab', text: '⇧Tab', label: 'Shift+Tab' },
  { key: 'up', text: '↑', label: '위 화살표' },
  { key: 'down', text: '↓', label: '아래 화살표' },
  { key: 'left', text: '←', label: '왼쪽 화살표' },
  { key: 'right', text: '→', label: '오른쪽 화살표' },
  { key: 'enter', text: 'Enter', label: 'Enter' },
  { key: 'ctrl-c', text: '⌃C', label: 'Ctrl+C' },
]
