import { describe, expect, it } from 'vitest'
import { keyBytes, QUICK_KEYS } from './keys'

describe('keyBytes', () => {
  it('sends the bytes a terminal keyboard sends', () => {
    expect(keyBytes('esc', false)).toBe('\x1b')
    expect(keyBytes('tab', false)).toBe('\t')
    expect(keyBytes('shift-tab', false)).toBe('\x1b[Z')
    expect(keyBytes('enter', false)).toBe('\r')
    expect(keyBytes('ctrl-c', false)).toBe('\x03')
    expect(['up', 'down', 'right', 'left'].map((k) => keyBytes(k as 'up', false))).toEqual(['\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D'])
  })

  it('sends SS3 arrows when the program asked for application cursor keys', () => {
    expect(['up', 'down', 'right', 'left'].map((k) => keyBytes(k as 'up', true))).toEqual(['\x1bOA', '\x1bOB', '\x1bOC', '\x1bOD'])
    expect(keyBytes('esc', true)).toBe('\x1b')
  })

  it('labels every quick key for a screen reader', () => {
    for (const k of QUICK_KEYS) expect(k.label.length).toBeGreaterThan(0)
    expect(QUICK_KEYS.map((k) => k.key)).toEqual(['esc', 'tab', 'shift-tab', 'up', 'down', 'left', 'right', 'enter', 'ctrl-c'])
  })
})
