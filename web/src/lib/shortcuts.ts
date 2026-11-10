// The keys for moving between sessions (spec §3 #198): Alt+Shift+↓ and ↑ go
// to the next and the previous session waiting for approval on any host,
// and ⌘P (Ctrl+P off a Mac) opens 세션 이동. They work in fields and in a
// terminal too, where Ctrl+P is the shell's own: there it takes Shift as well.

export type Shortcut = 'next' | 'prev' | 'switch'

/** What the key asks for; apple: ⌘ is the command key; inTerm: a terminal has the focus. */
export function shortcutOf(e: KeyboardEvent, apple: boolean, inTerm: boolean): Shortcut | null {
  if (e.isComposing || e.keyCode === 229) return null
  if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey) {
    if (e.key === 'ArrowDown') return 'next'
    if (e.key === 'ArrowUp') return 'prev'
    return null
  }
  if (e.altKey || letterOf(e) !== 'p') return null
  if (apple) return e.metaKey && !e.ctrlKey && !e.shiftKey ? 'switch' : null
  if (!e.ctrlKey || e.metaKey) return null
  return e.shiftKey || !inTerm ? 'switch' : null
}

// The letter the key types: a Latin one as the layout has it (⌘L on Dvorak is
// not ⌘P), else the key's place, as a Korean layout types ㅔ there.
function letterOf(e: KeyboardEvent): string {
  if (/^[a-z]$/i.test(e.key)) return e.key.toLowerCase()
  return e.code.startsWith('Key') ? e.code.slice(3).toLowerCase() : ''
}

export interface ShortcutOptions {
  apple: boolean
  /** The class of the dialog the keys still reach: 세션 이동's own. */
  own: string
}

/**
 * Takes the keys before a terminal or a field does, until the returned
 * function stops it. Another modal dialog keeps them, so a key cannot leave
 * what it asks. A held key does it once.
 */
export function startShortcuts(act: (s: Shortcut) => void, o: ShortcutOptions): () => void {
  const onKey = (e: KeyboardEvent) => {
    const inTerm = !!(document.activeElement as Element | null)?.closest?.('.xterm')
    const s = shortcutOf(e, o.apple, inTerm)
    if (!s) return
    const modal = document.querySelector('dialog[open]')
    if (modal && !modal.classList.contains(o.own)) return
    e.preventDefault()
    e.stopPropagation()
    if (!e.repeat) act(s)
  }
  window.addEventListener('keydown', onKey, true)
  return () => window.removeEventListener('keydown', onKey, true)
}
