import { afterEach, describe, expect, it, vi } from 'vitest'
import { shortcutOf, startShortcuts, type Shortcut } from './shortcuts'

const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })

describe('shortcutOf', () => {
  it('opens 세션 이동 with ⌘P on a Mac and Ctrl+P elsewhere', () => {
    expect(shortcutOf(key({ key: 'p', code: 'KeyP', metaKey: true }), true, false)).toBe('switch')
    expect(shortcutOf(key({ key: 'p', code: 'KeyP', ctrlKey: true }), true, false)).toBeNull()
    expect(shortcutOf(key({ key: 'P', code: 'KeyP', metaKey: true, shiftKey: true }), true, false)).toBeNull()
    expect(shortcutOf(key({ key: 'p', code: 'KeyP', ctrlKey: true }), false, false)).toBe('switch')
    expect(shortcutOf(key({ key: 'p', code: 'KeyP', metaKey: true }), false, false)).toBeNull()
    expect(shortcutOf(key({ key: 'p', code: 'KeyP', ctrlKey: true, altKey: true }), false, false)).toBeNull()
  })

  it('leaves Ctrl+P to the shell in a terminal, where Ctrl+Shift+P opens it', () => {
    expect(shortcutOf(key({ key: 'p', code: 'KeyP', ctrlKey: true }), false, true)).toBeNull()
    expect(shortcutOf(key({ key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true }), false, true)).toBe('switch')
    // ⌘P is no terminal's.
    expect(shortcutOf(key({ key: 'p', code: 'KeyP', metaKey: true }), true, true)).toBe('switch')
  })

  it('steps through the sessions that wait for approval with Alt+Shift+↓ and ↑', () => {
    expect(shortcutOf(key({ key: 'ArrowDown', altKey: true, shiftKey: true }), false, true)).toBe('next')
    expect(shortcutOf(key({ key: 'ArrowUp', altKey: true, shiftKey: true }), true, false)).toBe('prev')
    expect(shortcutOf(key({ key: 'ArrowDown', altKey: true }), false, false)).toBeNull()
    expect(shortcutOf(key({ key: 'ArrowDown', altKey: true, shiftKey: true, ctrlKey: true }), false, false)).toBeNull()
    expect(shortcutOf(key({ key: 'ArrowLeft', altKey: true, shiftKey: true }), false, false)).toBeNull()
  })

  it('takes the P key where a Korean layout types ㅔ, but not a Dvorak L', () => {
    expect(shortcutOf(key({ key: 'ㅔ', code: 'KeyP', ctrlKey: true }), false, false)).toBe('switch')
    expect(shortcutOf(key({ key: 'l', code: 'KeyP', metaKey: true }), true, false)).toBeNull()
    expect(shortcutOf(key({ key: 'p', code: 'KeyR', metaKey: true }), true, false)).toBe('switch')
  })

  it('lets a composition be', () => {
    expect(shortcutOf(key({ key: 'p', code: 'KeyP', ctrlKey: true, isComposing: true }), false, false)).toBeNull()
    expect(shortcutOf(key({ key: 'Process', code: 'KeyP', ctrlKey: true, keyCode: 229 }), false, false)).toBeNull()
  })
})

describe('startShortcuts', () => {
  const stops: (() => void)[] = []
  afterEach(() => {
    for (const s of stops.splice(0)) s()
    document.body.innerHTML = ''
  })

  function start() {
    const got: Shortcut[] = []
    stops.push(startShortcuts((s) => got.push(s), { apple: false, own: 'qs' }))
    return got
  }

  it('takes the key before a field does, once while it is held', () => {
    const got = start()
    const field = document.body.appendChild(document.createElement('textarea'))
    const own = vi.fn()
    field.addEventListener('keydown', own)
    const e = key({ key: 'p', code: 'KeyP', ctrlKey: true })
    field.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
    expect(own).not.toHaveBeenCalled()
    const held = key({ key: 'p', code: 'KeyP', ctrlKey: true, repeat: true })
    field.dispatchEvent(held)
    expect(held.defaultPrevented).toBe(true)
    expect(got).toEqual(['switch'])
    const plain = key({ key: 'p', code: 'KeyP' })
    field.dispatchEvent(plain)
    expect(plain.defaultPrevented).toBe(false)
    expect(own).toHaveBeenCalledTimes(1)
  })

  it('leaves Ctrl+P to a focused terminal', () => {
    const got = start()
    const term = document.body.appendChild(document.createElement('div'))
    term.className = 'xterm'
    const input = term.appendChild(document.createElement('textarea'))
    input.focus()
    const e = key({ key: 'p', code: 'KeyP', ctrlKey: true })
    input.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
    input.dispatchEvent(key({ key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true }))
    expect(got).toEqual(['switch'])
  })

  it('leaves the keys to another dialog, but not to its own', () => {
    const got = start()
    const other = document.body.appendChild(document.createElement('dialog'))
    other.setAttribute('open', '')
    const e = key({ key: 'ArrowDown', altKey: true, shiftKey: true })
    document.body.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
    other.className = 'sheet qs'
    document.body.dispatchEvent(key({ key: 'ArrowDown', altKey: true, shiftKey: true }))
    expect(got).toEqual(['next'])
  })

  it('stops', () => {
    const got: Shortcut[] = []
    startShortcuts((s) => got.push(s), { apple: true, own: 'qs' })()
    document.body.dispatchEvent(key({ key: 'p', code: 'KeyP', metaKey: true }))
    expect(got).toEqual([])
  })
})
