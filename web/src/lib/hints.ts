// A window's hint line, read as buttons (pickers design §6.3). Claude Code
// ends a window with a line like "Enter to select · ↑/↓ to navigate · Esc to
// cancel": every part names its keys, then what they do. A line is a hint
// line only when every part reads so. The keys come out in the names the
// core takes ('enter', 'shift+left', 'ctrl+e'), and each button says in
// Korean what the key does, or shows the key and the English words.

export interface HintPart {
  /** The keys, as the core names them. */
  keys: string[]
  /** What they do, as the line says it. */
  action: string
}

export interface Hint {
  label: string
  /** What a screen reader says, when the label is a symbol. */
  aria?: string
  key: string
  /** The key moves in the window rather than answering it (spec §3 #194: no expect). */
  move: boolean
  /** Mori copies what the window shows, rather than pressing the key. */
  copy?: boolean
  /** It deletes something: drawn as a danger and put last. */
  danger?: boolean
}

const BASE = '(?:enter|return|escape|esc|tab|space|backspace|up|down|left|right|[↑↓←→]|[a-z0-9[\\]?])'
const KEY = `(?:(?:ctrl|shift|alt)\\+)*${BASE}`
// "/" joins a pair (↑/↓), ", " and " or " a list (Space, Enter or Esc).
const SEP = '(?:\\s*/\\s*|,\\s*(?:or\\s+)?|\\s+or\\s+)'
const PART = new RegExp(`^(?:press\\s+)?(${KEY}(?:${SEP}${KEY})*)\\s+to\\s+(\\S.*)$`, 'i')
const SPLIT = new RegExp(`(${SEP})`, 'i')
const MODS = /^((?:(?:ctrl|shift|alt)\+)*)(.+)$/i

const NAMES: Record<string, string> = {
  enter: 'enter',
  return: 'enter',
  esc: 'esc',
  escape: 'esc',
  tab: 'tab',
  space: 'space',
  backspace: 'backspace',
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  '↑': 'up',
  '↓': 'down',
  '←': 'left',
  '→': 'right',
}

/** The parts of a hint line, or null when the line is something else. */
export function hintLine(text: string): HintPart[] | null {
  const t = text.trim()
  if (!t) return null
  const parts: HintPart[] = []
  for (const piece of t.split(/\s+·\s+/)) {
    const m = PART.exec(piece)
    if (!m) return null
    const tokens = m[1].split(SPLIT)
    const keys: string[] = []
    let held: string[] = []
    for (let i = 0; i < tokens.length; i += 2) {
      const [, pre, base] = MODS.exec(tokens[i])!
      let mods = pre ? pre.toLowerCase().slice(0, -1).split('+') : []
      // shift+←/→: the bare key after a slash keeps the modifiers before it
      if (!mods.length && i > 0 && tokens[i - 1].trim() === '/') mods = held
      held = mods
      // the core does not take '?'
      if (base === '?') continue
      const name = NAMES[base.toLowerCase()] ?? (mods.length ? base.toLowerCase() : base)
      keys.push([...mods, name].join('+'))
    }
    parts.push({ keys, action: m[2].trim() })
  }
  return parts
}

const SHOW: Record<string, string> = { enter: 'Enter', esc: 'Esc', tab: 'Tab', space: 'Space', backspace: 'Backspace', up: '↑', down: '↓', left: '←', right: '→' }
const ARIA: Record<string, string> = { up: '위 화살표', down: '아래 화살표', left: '왼쪽 화살표', right: '오른쪽 화살표' }
const MOVES = new Set(['up', 'down', 'left', 'right', 'shift+up', 'shift+down', 'shift+left', 'shift+right', 'space', 'tab', 'shift+tab'])

/** How a key shows on a button: Enter, ⇧Tab, Ctrl+E, ↑; a letter as it is. */
function shown(name: string): string {
  if ([...name].length === 1) return name
  const mods = name.split('+')
  const base = mods.pop()!
  const pre = mods.map((m) => (m === 'shift' ? '⇧' : m === 'ctrl' ? 'Ctrl+' : 'Alt+')).join('')
  return pre + (SHOW[base] ?? base.toUpperCase())
}

const button = (label: string, key: string): Hint => ({ label, key, move: MOVES.has(key) })

const SKIP = /^(?:amend|add notes?)\b/
const SELECT = /^(?:select|confirm|choose|submit)\b/
const CLOSE = /^(?:cancel|exit|close|dismiss)\b/
const COPY = /^copy\b/
const SESSION = /\bthis session only\b/
const DANGER = /^(?:delete|remove|clear|discard)\b/
const NAVIGATE = /^navigate\b/
const SCROLL = /^scroll\b/
const EFFORT = /\beffort\b/
const ANSWERS = /\b(?:answers?|responses?)\b/

/** One key's button where each key of the part gets its own. */
function each(key: string, a: string, action: string): Hint {
  const base = key.replace(/^shift\+/, '')
  if (NAVIGATE.test(a) && ARIA[key]) return { ...button(SHOW[key], key), aria: ARIA[key] }
  if (SCROLL.test(a) && (key === 'up' || key === 'down')) return button(key === 'up' ? '위로' : '아래로', key)
  if (EFFORT.test(a) && (key === 'left' || key === 'right')) return button(key === 'left' ? '노력 낮추기' : '노력 높이기', key)
  if (ANSWERS.test(a) && (base === 'left' || base === 'right')) return button(base === 'left' ? '이전 답' : '다음 답', key)
  return button(`${shown(key)} · ${action}`, key)
}

/** The buttons of a hint line, in its order, with what deletes put last. */
export function readHints(parts: HintPart[]): Hint[] {
  const out: Hint[] = []
  const last: Hint[] = []
  for (const { keys, action } of parts) {
    if (!keys.length) continue
    const a = action.toLowerCase()
    if (SKIP.test(a)) continue
    // 고르기 is Enter's alone: a list where many can be chosen ticks with another key, named as it is
    if (SELECT.test(a) && keys.includes('enter')) out.push(button('고르기', 'enter'))
    else if (CLOSE.test(a)) out.push(button('닫기', keys.includes('esc') ? 'esc' : keys[0]))
    else if (COPY.test(a)) out.push({ ...button('복사', keys[0]), copy: true })
    else if (SESSION.test(a)) out.push(button('이 세션만', keys[0]))
    else if (DANGER.test(a)) last.push(...keys.map((k) => ({ ...button(`${shown(k)} · ${action}`, k), danger: true })))
    else out.push(...keys.map((k) => each(k, a, action)))
  }
  return [...out, ...last]
}
