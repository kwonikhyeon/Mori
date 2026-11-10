import { describe, expect, it } from 'vitest'
import { keyBytes, LOCK_MS, QUICK_KEYS, strayBytes, tapMod, withMods, type StrayKey } from './keys'

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
    expect(QUICK_KEYS.map((k) => k.key)).toEqual(['esc', 'ctrl', 'alt', 'tab', 'shift-tab', 'up', 'down', 'left', 'right', 'enter', 'ctrl-c'])
  })

  it('sends a held Ctrl or Alt with the quick keys', () => {
    // Alt+Enter is a new line in Claude Code
    expect(keyBytes('enter', false, false, true)).toBe('\x1b\r')
    expect(keyBytes('esc', false, false, true)).toBe('\x1b\x1b')
    expect(keyBytes('tab', false, true, false)).toBe('\t')
    // a modified arrow takes the CSI form even in application mode
    expect(keyBytes('left', true, true, false)).toBe('\x1b[1;5D')
    expect(keyBytes('right', false, false, true)).toBe('\x1b[1;3C')
    expect(keyBytes('up', true, true, true)).toBe('\x1b[1;7A')
    expect(keyBytes('shift-tab', false, true, true)).toBe('\x1b[Z')
  })
})

describe('withMods', () => {
  it('makes a letter or a sign its control character', () => {
    expect(withMods('c', true, false)).toBe('\x03')
    expect(withMods('R', true, false)).toBe('\x12')
    expect(['@', ' ', '[', '\\', ']', '^', '_', '?'].map((k) => withMods(k, true, false))).toEqual([
      '\x00',
      '\x00',
      '\x1b',
      '\x1c',
      '\x1d',
      '\x1e',
      '\x1f',
      '\x7f',
    ])
    // Ctrl with Backspace deletes a word
    expect(withMods('\x7f', true, false)).toBe('\x17')
    expect(withMods('1', true, false)).toBe('1')
  })

  it('puts ESC before a key with Alt, and before its control character with both', () => {
    expect(withMods('b', false, true)).toBe('\x1bb')
    expect(withMods('\x7f', false, true)).toBe('\x1b\x7f')
    expect(withMods('x', true, true)).toBe('\x1b\x18')
  })

  it('leaves what is not one key as it is', () => {
    expect(withMods('한', true, true)).toBe('한')
    expect(withMods('ls -la', true, false)).toBe('ls -la')
    expect(withMods('\x1b[A', false, true)).toBe('\x1b[A')
    expect(withMods('c', false, false)).toBe('c')
  })
})

describe('tapMod', () => {
  it('holds for the next key, holds on a quick second tap, and lets go', () => {
    expect(tapMod('off', Infinity)).toBe('once')
    expect(tapMod('once', LOCK_MS - 1)).toBe('lock')
    expect(tapMod('once', LOCK_MS)).toBe('off')
    expect(tapMod('lock', 10)).toBe('off')
  })
})

describe('strayBytes', () => {
  const press = (key: string, more: Partial<StrayKey> = {}): StrayKey => ({
    key,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
    keyCode: 0,
    ...more,
  })

  it('types a letter, Enter, Backspace and the arrows', () => {
    expect(['y', 'Y', ' ', '1', '😀'].map((k) => strayBytes(press(k), false))).toEqual(['y', 'Y', ' ', '1', '😀'])
    expect(['Enter', 'Backspace'].map((k) => strayBytes(press(k), false))).toEqual(['\r', '\x7f'])
    expect(strayBytes(press('ArrowUp'), false)).toBe('\x1b[A')
    expect(strayBytes(press('ArrowLeft'), true)).toBe('\x1bOD')
  })

  it('leaves the shortcuts, the other keys and a syllable being composed', () => {
    expect(strayBytes(press('c', { ctrlKey: true }), false)).toBeNull()
    expect(strayBytes(press('p', { metaKey: true }), false)).toBeNull()
    expect(strayBytes(press('ArrowDown', { altKey: true }), false)).toBeNull()
    expect(strayBytes(press('Tab'), false)).toBeNull()
    // it closes what is open on the page
    expect(strayBytes(press('Escape'), false)).toBeNull()
    expect(strayBytes(press('F5'), false)).toBeNull()
    expect(strayBytes(press('ㅎ', { isComposing: true }), false)).toBeNull()
    expect(strayBytes(press('Process', { keyCode: 229 }), false)).toBeNull()
  })
})
