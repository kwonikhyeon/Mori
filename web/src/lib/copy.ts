// Copying a text for people to paste elsewhere. The clipboard API needs a
// secure page, and Mori over the tailnet is often plain http: there the
// selection of a hidden text box is copied instead.
import { toast } from './toast'

export async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Refused, as when the page is not in front: the old way may still do.
    }
  }
  const back = document.activeElement as HTMLElement | null
  const ta = document.createElement('textarea')
  ta.value = text
  // Read-only keeps a phone's keyboard down; 16px keeps iOS from zooming in.
  ta.setAttribute('readonly', '')
  ta.setAttribute('aria-hidden', 'true')
  Object.assign(ta.style, { position: 'fixed', top: '0', left: '0', opacity: '0', fontSize: '16px' })
  document.body.appendChild(ta)
  ta.focus()
  ta.select()
  ta.setSelectionRange(0, text.length)
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  ta.remove()
  back?.focus?.()
  return ok
}

/**
 * The text a program asks to copy with OSC 52 ("c;<base64>"), '' for its
 * clear, or null for a read ("?") or what does not decode. Reads are never
 * answered: a program may write the clipboard, never see it.
 */
export function osc52Text(data: string): string | null {
  const at = data.indexOf(';')
  const b64 = at < 0 ? null : data.slice(at + 1)
  if (b64 === null || b64 === '?') return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
  } catch {
    return null
  }
}

/** Copies text and says so in a toast, or that it could not. */
export async function copyAndTell(text: string, done: string): Promise<void> {
  if (await copyText(text)) toast(done)
  else toast('복사하지 못했습니다', 'error')
}
