import { describe, expect, it } from 'vitest'
import { automatic } from './autoinput'

// What xterm.js types by itself goes apart from typing, which the core's
// send and keys wait out (spec §3 #237).
describe('automatic', () => {
  it('takes replies to the program and focus reports', () => {
    for (const s of [
      '\x1b[I',
      '\x1b[O',
      '\x1b[12;40R',
      '\x1b[0n',
      '\x1b[?1;2c',
      '\x1b[>0;276;0c',
      '\x1b[?2026;2$y',
      '\x1b[4;600;800t',
      '\x1b[?0u',
      '\x1b]11;rgb:1f1f/1e1e/1c1c\x1b\\',
      '\x1b]10;rgb:ecec/eaea/e5e5\x07',
      '\x1bP>|xterm.js(5.5.0)\x1b\\',
    ])
      expect(automatic(s), JSON.stringify(s)).toBe(true)
  })

  it('takes a pointer moving with no button held, in SGR and urxvt reports', () => {
    expect(automatic('\x1b[<35;35;14M')).toBe(true)
    expect(automatic('\x1b[<39;35;14M')).toBe(true) // with Shift
    expect(automatic('\x1b[<35;35;14M\x1b[<35;36;14M')).toBe(true)
    expect(automatic('\x1b[67;35;14M')).toBe(true) // urxvt: 35 + 32
  })

  it('leaves keys, clicks, the wheel and drags to typing', () => {
    for (const s of [
      '1',
      'ls\r',
      '\r',
      '\x1b',
      '\x1b[A',
      '\x1b[1;5C',
      '\x1b[Z',
      '\x1b[3~',
      '\x1b[200~text\x1b[201~',
      '\x1b[<0;35;14M', // press
      '\x1b[<0;35;14m', // release
      '\x1b[<32;35;14M', // drag with the left button
      '\x1b[<64;35;14M', // wheel up
      '\x1b[<35;35;14Mx', // motion, then a key
      '\x1b[32;35;14M', // urxvt press
    ])
      expect(automatic(s), JSON.stringify(s)).toBe(false)
  })
})
