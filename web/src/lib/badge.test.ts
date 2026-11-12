import { afterEach, describe, expect, it, vi } from 'vitest'
import { showNeeds } from './badge'

afterEach(() => {
  delete (navigator as { setAppBadge?: unknown }).setAppBadge
  delete (navigator as { clearAppBadge?: unknown }).clearAppBadge
})

// The count is in the page title only; the app icon shows none (spec §3 #240).
describe('showNeeds', () => {
  it('puts the count in the title and none on the app icon', () => {
    const set = vi.fn(async () => {})
    const clear = vi.fn(async () => {})
    Object.assign(navigator, { setAppBadge: set, clearAppBadge: clear })
    showNeeds(3)
    expect(document.title).toBe('(3) Mori')
    showNeeds(0)
    expect(document.title).toBe('Mori')
    expect(set).not.toHaveBeenCalled()
    // a number an earlier Mori put on the icon goes
    expect(clear).toHaveBeenCalledTimes(2)
  })

  it('does without the Badging API, or the leave to clear a badge', async () => {
    showNeeds(2)
    expect(document.title).toBe('(2) Mori')
    Object.assign(navigator, { clearAppBadge: () => Promise.reject(new Error('denied')) })
    showNeeds(1)
    await Promise.resolve()
    expect(document.title).toBe('(1) Mori')
  })
})
