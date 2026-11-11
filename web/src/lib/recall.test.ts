import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Recall, rememberSent, sentHere } from './recall'

beforeEach(() => localStorage.clear())
afterEach(() => vi.useRealTimers())

describe('Recall', () => {
  it('walks back and forth, and comes back to what was being written', async () => {
    let loads = 0
    const r = new Recall(async () => {
      loads++
      return ['b', 'a']
    })
    expect(r.browsing).toBe(false)
    expect(await r.older('쓰던')).toBe('b')
    expect(r.browsing).toBe(true)
    expect(await r.older('b')).toBe('a')
    expect(await r.older('a')).toBeNull()
    expect(r.newer()).toBe('b')
    expect(r.newer()).toBe('쓰던')
    expect(r.browsing).toBe(false)
    expect(r.newer()).toBeNull()
    // an edit leaves the walk, and the list stays
    await r.older('x')
    r.reset()
    expect(await r.older('y')).toBe('b')
    expect(loads).toBe(1)
    // after a send the list is read again
    r.refresh()
    await r.older('')
    expect(loads).toBe(2)
  })

  // Claude Code may not have written a send to its record yet when the list is read again.
  it('puts what was just sent first, once', async () => {
    let record = ['b', 'a']
    const r = new Recall(async () => record)
    r.sent('c')
    expect(await r.older('')).toBe('c')
    expect(await r.older('c')).toBe('b')
    record = ['c', 'b', 'a']
    r.refresh()
    expect(await r.older('')).toBe('c')
    expect(await r.older('c')).toBe('b')
  })
})

describe('what was sent here', () => {
  it('keeps the newest 100, a repeat once, per terminal', () => {
    for (let i = 0; i < 105; i++) rememberSent('h.t1.1', `글 ${i}`)
    rememberSent('h.t1.1', '글 104')
    rememberSent('h.t2.1', '다른 터미널')
    const got = sentHere('h.t1.1')
    expect(got).toHaveLength(100)
    expect(got[0]).toBe('글 104')
    expect(got[99]).toBe('글 5')
    expect(sentHere('h.t2.1')).toEqual(['다른 터미널'])
    // a new terminal at the same address starts with nothing
    expect(sentHere('h.t1.2')).toEqual([])
  })

  it('forgets what is 30 days old, and terminals gone that long', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'))
    rememberSent('h.t1.1', '오래된 글')
    rememberSent('h.t9.1', '사라진 터미널')
    vi.setSystemTime(new Date('2026-11-01T00:00:00Z'))
    rememberSent('h.t1.1', '새 글')
    expect(sentHere('h.t1.1')).toEqual(['새 글'])
    expect(localStorage.getItem('mori.sent.h.t9.1')).toBeNull()
  })
})
