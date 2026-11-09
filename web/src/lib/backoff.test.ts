import { describe, expect, it } from 'vitest'
import { Backoff } from './backoff'

describe('Backoff', () => {
  it('doubles from half a second up to ten', () => {
    const b = new Backoff(500, 10_000, 0.2, () => 0.5)
    expect(Array.from({ length: 8 }, () => b.next())).toEqual([500, 1000, 2000, 4000, 8000, 10_000, 10_000, 10_000])
  })

  it('starts over after reset', () => {
    const b = new Backoff(500, 10_000, 0.2, () => 0.5)
    b.next()
    b.next()
    b.reset()
    expect(b.next()).toBe(500)
  })

  it('shakes each wait by up to a fifth', () => {
    expect(new Backoff(500, 10_000, 0.2, () => 0).next()).toBe(400)
    expect(new Backoff(500, 10_000, 0.2, () => 0.9999).next()).toBe(600)
    const b = new Backoff()
    for (let i = 0; i < 100; i++) {
      const d = b.next()
      expect(d).toBeGreaterThanOrEqual(400)
      expect(d).toBeLessThanOrEqual(12_000)
    }
  })
})
