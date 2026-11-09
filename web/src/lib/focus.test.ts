import { afterEach, describe, expect, it, vi } from 'vitest'
import { watchFocus } from './focus'

afterEach(() => vi.restoreAllMocks())

describe('watchFocus', () => {
  it('says at once and then only on a change whether a person sees the page', () => {
    let focused = true
    let visible: DocumentVisibilityState = 'visible'
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible)
    const seen: boolean[] = []
    const stop = watchFocus((f) => seen.push(f))
    expect(seen).toEqual([true])

    focused = false
    window.dispatchEvent(new Event('blur'))
    window.dispatchEvent(new Event('blur'))
    expect(seen).toEqual([true, false])

    focused = true
    window.dispatchEvent(new Event('focus'))
    expect(seen).toEqual([true, false, true])

    visible = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    expect(seen).toEqual([true, false, true, false])

    stop()
    visible = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    expect(seen).toEqual([true, false, true, false])
  })
})
