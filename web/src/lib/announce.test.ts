import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { announce, initAnnounce } from './announce'

const live = (at: Element, politeness: string) => at.querySelector(`:scope > [data-mori-live="${politeness}"]`)

// The page's regions, made at start as main.tsx makes them (test/setup.ts takes them away after).
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] })
  initAnnounce()
})

afterEach(() => {
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
  document.querySelectorAll('dialog').forEach((d) => d.remove())
})

describe('announce', () => {
  it('makes the page its two regions, empty, before any words', () => {
    const polite = live(document.body, 'polite')!
    const assertive = live(document.body, 'assertive')!
    expect(polite.getAttribute('role')).toBe('status')
    expect(polite.getAttribute('aria-live')).toBe('polite')
    expect(assertive.getAttribute('role')).toBe('alert')
    expect(assertive.getAttribute('aria-live')).toBe('assertive')
    for (const el of [polite, assertive]) {
      expect(el.getAttribute('aria-atomic')).toBe('true')
      expect(el.className).toBe('sr-only')
      expect(el.textContent).toBe('')
    }
  })

  it('sets the words a frame on, in the region of their urgency, and takes them away 2 s later', () => {
    announce('세션을 만들지 못했습니다', 'assertive')
    const assertive = live(document.body, 'assertive')!
    expect(assertive.textContent).toBe('')
    vi.advanceTimersToNextFrame()
    expect(assertive.textContent).toBe('세션을 만들지 못했습니다')
    expect(live(document.body, 'polite')!.textContent).toBe('')
    vi.advanceTimersByTime(2_000)
    expect(assertive.textContent).toBe('')
  })

  it('empties the region first, so the same words again are read again', () => {
    const polite = live(document.body, 'polite')!
    announce('복사했습니다')
    vi.advanceTimersToNextFrame()
    announce('복사했습니다')
    expect(polite.textContent).toBe('')
    vi.advanceTimersToNextFrame()
    expect(polite.textContent).toBe('복사했습니다')
  })

  it('reads the words of one frame together, each once', () => {
    announce('하나')
    announce('둘')
    announce('하나')
    vi.advanceTimersToNextFrame()
    expect(live(document.body, 'polite')!.textContent).toBe('하나 둘')
  })

  it('speaks inside an open modal dialog, as the page behind it is inert', () => {
    const dialog = document.createElement('dialog')
    document.body.appendChild(dialog)
    dialog.showModal()
    // The test DOM has no top layer; the dialog says it is modal, as a browser's does.
    vi.spyOn(dialog, 'matches').mockImplementation((s: string) => s === ':modal')
    announce('삭제하지 못했습니다', 'assertive')
    vi.advanceTimersToNextFrame()
    expect(live(dialog, 'assertive')!.textContent).toBe('삭제하지 못했습니다')
    expect(live(document.body, 'assertive')!.textContent).toBe('')
  })
})
