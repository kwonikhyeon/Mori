// A preset's argv as one line to edit (spec §3 #42): words split on spaces,
// and "…" or '…' keeps spaces and the other quote inside a word. A
// backslash is just a character, so Windows paths need no doubling.

/** The words of s, or null when a quote is left open. */
export function parseArgv(s: string): string[] | null {
  const out: string[] = []
  let word = ''
  let inWord = false
  let quote = ''
  for (const c of s) {
    if (quote) {
      if (c === quote) quote = ''
      else word += c
    } else if (c === '"' || c === "'") {
      quote = c
      inWord = true
    } else if (/\s/.test(c)) {
      if (inWord) out.push(word)
      word = ''
      inWord = false
    } else {
      word += c
      inWord = true
    }
  }
  if (quote) return null
  if (inWord) out.push(word)
  return out
}

/** The line parseArgv reads back as a. */
export function formatArgv(a: string[]): string {
  return a.map((w) => (w !== '' && !/[\s"']/.test(w) ? w : `"${w.replace(/"/g, `"'"'"`)}"`)).join(' ')
}
