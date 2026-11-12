// What xterm.js types by itself rather than for a person (spec §3 #237):
// replies to the program's queries, focus reports, and mouse reports of a
// pointer moving with no button held. They go to the core as
// AUTOMATIC_INPUT, which the program gets as ever but the core does not
// take for a person typing: terminal.send and terminal.keys wait until
// nobody has typed for about 3 s, and Claude Code asks for every mouse
// motion, so a pointer resting on the terminal held the approval bar's
// keys for as long as it moved. Keys, clicks, the wheel and drags stay
// typing.

/** One sequence xterm.js may type by itself, anchored at the start. */
const PARTS: RegExp[] = [
  /^\x1b\[[IO]/, // focus in, out (DECSET 1004)
  /^\x1b\[\d+;\d+R/, // cursor position (DSR 6)
  /^\x1b\[0n/, // status: OK (DSR 5)
  /^\x1b\[[?>][\d;]*c/, // device attributes (DA1, DA2)
  /^\x1b\[\??[\d;]*\$y/, // a mode's state (DECRQM)
  /^\x1b\[\d+(?:;\d+)*t/, // window reports (XTWINOPS)
  /^\x1b\[\?\d*u/, // kitty keyboard flags
  /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/, // OSC replies: colours, clipboard
  /^\x1bP[^\x1b]*\x1b\\/, // DCS replies: DECRQSS, XTVERSION
]

/** A mouse report (SGR 1006, or urxvt 1015) of motion with no button held. */
const MOTION = /^\x1b\[(<?)(\d+);\d+;\d+[Mm]/

/** cb is motion (32) with no button (low bits 3) and no wheel (64), whatever the modifiers. */
const hover = (cb: number) => (cb & 32) !== 0 && (cb & 3) === 3 && (cb & 64) === 0

/** The whole of s is sequences xterm.js typed by itself. */
export function automatic(s: string): boolean {
  if (!s.startsWith('\x1b')) return false
  let rest = s
  while (rest) {
    const m = MOTION.exec(rest)
    if (m) {
      // urxvt adds 32 to the button code, as the X10 encoding does
      const cb = Number(m[2]) - (m[1] ? 0 : 32)
      if (!hover(cb)) return false
      rest = rest.slice(m[0].length)
      continue
    }
    const p = PARTS.map((re) => re.exec(rest)).find((x) => x !== null)
    if (!p) return false
    rest = rest.slice(p[0].length)
  }
  return true
}
