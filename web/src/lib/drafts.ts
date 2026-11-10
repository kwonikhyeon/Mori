// What was typed into a terminal's composer and not sent yet (spec §3 #181).
// It stays on this device for a week, so leaving the screen, a reload or a
// new build does not lose it.

import { load, save } from './storage'

const KEY = 'mori.drafts'
export const DRAFT_DAYS = 7
const KEEP = DRAFT_DAYS * 24 * 3600_000

type Drafts = Record<string, { text: string; at: number }>

function kept(now: number): Drafts {
  const raw = load<unknown>(KEY, {})
  const out: Drafts = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const d = v as { text?: unknown; at?: unknown } | null
    if (d && typeof d.text === 'string' && d.text !== '' && typeof d.at === 'number' && now - d.at < KEEP) {
      out[k] = { text: d.text, at: d.at }
    }
  }
  return out
}

/** The key of a terminal's draft; the hub's host is ''. */
export function draftKey(host: string, addr: string): string {
  return host + '\u0000' + addr
}

export function loadDraft(key: string, now = Date.now()): string {
  return kept(now)[key]?.text ?? ''
}

/** Keeps text as the draft; '' forgets it. Drafts older than a week go as well. */
export function saveDraft(key: string, text: string, now = Date.now()): void {
  const d = kept(now)
  if (text === '') delete d[key]
  else d[key] = { text, at: now }
  save(KEY, d)
}
