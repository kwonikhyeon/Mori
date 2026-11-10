// hc's first paint after an attach (spec §3 #177): `\e[H\e[2J`, the history
// lines, each ending in \r\n, as many line feeds as the screen has rows to
// push them into the scrollback, then `\e[H\e[2J` again and the screen. The
// last \r\n already went down a row, so the last of those feeds pushes a
// blank row in after the history: scrolled back, a blank line stood between
// the history and the screen. paintFilter drops that feed. A paint of any
// other shape goes through as it came, and so does everything after it.

const CLEAR = [0x1b, 0x5b, 0x48, 0x1b, 0x5b, 0x32, 0x4a] // \e[H\e[2J
const ESC = 0x1b
const LF = 0x0a
const SGR = 0x6d // the final byte of \e[…m, the only sequence history has
/** The paint's first clear comes within its first few hundred bytes. */
const LOOK = 4096

type Phase = 'clear' | 'history' | 'feeds' | 'after' | 'done'

/** A filter for one attach's output; bytes go through it in order. */
export function paintFilter(rows: number): (d: Uint8Array) => Uint8Array {
  let phase: Phase = 'clear'
  let seen = 0 // bytes before the first clear
  let at = 0 // bytes of a clear matched
  let prev = -1 // the history's last text byte
  let esc = 0 // in the history: 1 after ESC, 2 inside a CSI
  let feeds = 0 // line feeds held back
  return (d) => {
    if (phase === 'done') return d
    // what is held back comes out with a later chunk
    const out = new Uint8Array(d.length + feeds + CLEAR.length)
    let n = 0
    const put = (b: number) => {
      out[n++] = b
    }
    const release = (lf: number, upto: number) => {
      for (let i = 0; i < lf; i++) put(LF)
      for (let i = 0; i < upto; i++) put(CLEAR[i])
    }
    const after = (b: number) => {
      if (b === CLEAR[at]) {
        if (++at < CLEAR.length) return
        release(feeds === rows ? feeds - 1 : feeds, CLEAR.length)
      } else {
        release(feeds, at)
        put(b)
      }
      feeds = 0
      phase = 'done'
    }
    for (let i = 0; i < d.length; i++) {
      const b = d[i]
      switch (phase) {
        case 'done':
          put(b)
          break
        case 'clear':
          put(b)
          at = b === CLEAR[at] ? at + 1 : b === CLEAR[0] ? 1 : 0
          if (at === CLEAR.length) {
            phase = 'history'
            at = 0
          } else if (++seen >= LOOK) phase = 'done'
          break
        case 'history':
          if (esc === 1) {
            put(b)
            if (b === 0x5b) esc = 2
            else phase = 'done'
          } else if (esc === 2) {
            put(b)
            if (b >= 0x40 && b <= 0x7e) {
              esc = 0
              prev = -1
              if (b !== SGR) phase = 'done'
            }
          } else if (b === ESC) {
            put(b)
            esc = 1
          } else if (b === LF && prev === LF) {
            // a line feed after the end of a line: the push begins
            phase = 'feeds'
            feeds = 1
          } else {
            put(b)
            prev = b
          }
          break
        case 'feeds':
          if (b === LF) {
            if (++feeds > rows) {
              release(feeds, 0)
              feeds = 0
              phase = 'done'
            }
            break
          }
          // this byte may begin the clear
          phase = 'after'
          at = 0
          after(b)
          break
        case 'after':
          after(b)
          break
      }
    }
    return out.subarray(0, n)
  }
}
