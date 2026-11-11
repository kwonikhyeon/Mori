// Pressing a Claude Code window from its panel (pickers design §6.5). Each
// press first checks that the screen still shows the window the panel drew,
// down to its signature, so that a key never lands on another window. An
// item is reached by its number where the program is blocked on it (spec §3
// #194: the number carries expect), and by moving the cursor elsewhere: the
// Enter goes only once the cursor shows on the item. A list where many can
// be chosen is only moved in: its hint keys tick and submit (design §6.5).
// Moving counts from the item under the cursor: with the cursor on a row
// without a number, only a blocked window's number reaches an item.

import type { Hint } from './hints'
import { alike, type Look, type Seen } from './pick'

/** The terminal a press goes to, and the screen it reads back. */
export interface Press {
  /** What the bottom of the screen shows now. */
  now(): Look
  /** The first look that passes test, from now on; null after ms. */
  wait(test: (l: Look) => boolean, ms: number): Promise<Look | null>
  /** Keys that move in the window: they answer nothing. */
  move(names: string[]): Promise<void>
  /** A key that answers the window. */
  answer(name: string): Promise<void>
}

/** How long the cursor may take to show on the item before Enter. */
export const SEE_MS = 1500

/** How long a window may take to close after Esc. */
export const CLOSE_MS = 2000

/** The screen still shows the window as the panel drew it. */
const same = (p: Press, seen: Seen) => p.now().seen?.sig === seen.sig

/** Many can be chosen: the items have checkboxes. */
const many = (seen: Seen) => seen.options.some((o) => o.mark === 'on' || o.mark === 'off')

/** Item n can be chosen from where the cursor stands: moving needs the cursor on an item; a blocked window takes the number. */
export const reach = (seen: Seen, n: number, blocked: boolean) => seen.cursor > 0 || (blocked && n <= 9 && !many(seen))

/** Chooses item n; false when the window changed, or n cannot be reached, and nothing was chosen. */
export async function choose(p: Press, seen: Seen, n: number, blocked: boolean): Promise<boolean> {
  if (!same(p, seen) || !reach(seen, n, blocked)) return false
  const multi = many(seen)
  if (blocked && n <= 9 && !multi) {
    await p.answer(String(n))
    return true
  }
  const d = n - seen.cursor
  if (d !== 0) await p.move(Array<string>(Math.abs(d)).fill(d > 0 ? 'down' : 'up'))
  if (multi) return true
  const at = await p.wait((l) => !!l.seen && alike(l.seen, seen) && l.seen.cursor === n, SEE_MS)
  if (!at) return false
  await p.answer('enter')
  return true
}

/** Presses a hint's key; false when the window changed and nothing was sent. */
export async function tap(p: Press, seen: Seen, hint: Hint): Promise<boolean> {
  if (!same(p, seen)) return false
  if (hint.move) await p.move([hint.key])
  else await p.answer(hint.key)
  return true
}

/**
 * Closes the window before a message goes: Esc, then the input box with no
 * window. True once the box shows; false when another window shows, or the
 * window stays.
 */
export async function closeFor(p: Press, seen: Seen): Promise<boolean> {
  const l = p.now()
  if (l.seen && l.seen.sig !== seen.sig) return false
  if (l.seen) await p.answer('esc')
  return (await p.wait((x) => !x.seen && !!x.box, CLOSE_MS)) !== null
}
