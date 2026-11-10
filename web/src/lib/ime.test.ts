import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chordKey, chordSubmit, type Field } from './ime'

let t = 0
let sent: string[] = []
let field: HTMLTextAreaElement

const key = (o: Partial<KeyboardEventInit> & { keyCode?: number } = {}) => {
  const e = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', cancelable: true, ...o })
  if (o.keyCode !== undefined) Object.defineProperty(e, 'keyCode', { value: o.keyCode })
  Object.defineProperty(e, 'currentTarget', { value: field })
  return e
}
const end = () => {
  const e = new CompositionEvent('compositionend')
  Object.defineProperty(e, 'currentTarget', { value: field })
  return e
}

beforeEach(() => {
  vi.useFakeTimers()
  t = 1_000_000
  sent = []
  field = document.createElement('textarea')
})

afterEach(() => {
  vi.useRealTimers()
})

const make = () => chordSubmit((f: Field) => sent.push(f.value), () => t)

describe('chordKey', () => {
  it('sends on ⌘ or Ctrl + Enter, later while composing, and leaves the rest', () => {
    expect(chordKey(key({ metaKey: true }))).toBe('send')
    expect(chordKey(key({ ctrlKey: true, key: 'Enter', code: 'NumpadEnter' }))).toBe('send')
    expect(chordKey(key({ ctrlKey: true, isComposing: true }))).toBe('later')
    expect(chordKey(key({ metaKey: true, key: 'Process', keyCode: 229 }))).toBe('later')
    expect(chordKey(key())).toBeNull()
    expect(chordKey(key({ shiftKey: true }))).toBeNull()
    expect(chordKey(key({ key: 'a', code: 'KeyA', ctrlKey: true }))).toBeNull()
  })
})

describe('chordSubmit', () => {
  it('sends at once when nothing is being composed', () => {
    const c = make()
    field.value = 'go on'
    const e = key({ ctrlKey: true })
    c.onKeyDown(e)
    expect(e.defaultPrevented).toBe(true)
    expect(sent).toEqual(['go on'])
  })

  it('sends the syllable still being composed once the IME has put it in', () => {
    const c = make()
    field.value = '안녕하'
    c.onKeyDown(key({ metaKey: true, isComposing: true }))
    expect(sent).toEqual([])
    t += 30
    field.value = '안녕하세'
    c.onCompositionEnd(end())
    expect(sent).toEqual([])
    vi.advanceTimersByTime(0)
    expect(sent).toEqual(['안녕하세'])
    // the press is used up
    t += 100
    c.onCompositionEnd(end())
    vi.advanceTimersByTime(0)
    expect(sent).toEqual(['안녕하세'])
  })

  it('does not send for a composition that ends long after the press', () => {
    const c = make()
    c.onKeyDown(key({ ctrlKey: true, isComposing: true }))
    t += 1001
    c.onCompositionEnd(end())
    vi.advanceTimersByTime(0)
    expect(sent).toEqual([])
  })

  it('sends when the composition ended just before the press, as in Safari', () => {
    const c = make()
    field.value = '테스트'
    c.onCompositionEnd(end())
    t += 5
    c.onKeyDown(key({ metaKey: true, keyCode: 229 }))
    vi.advanceTimersByTime(0)
    expect(sent).toEqual(['테스트'])
    // an end long before a press is not its own
    t += 10_000
    c.onCompositionEnd(end())
    t += 500
    c.onKeyDown(key({ metaKey: true, keyCode: 229 }))
    vi.advanceTimersByTime(0)
    expect(sent).toEqual(['테스트'])
  })
})
