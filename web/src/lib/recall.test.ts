import { beforeEach, describe, expect, it } from 'vitest'
import { Recall, rememberSent, sentHere } from './recall'

beforeEach(() => localStorage.clear())

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
})

describe('what was sent here', () => {
  it('keeps the newest 100, a repeat once, per host and terminal', () => {
    for (let i = 0; i < 105; i++) rememberSent('h', 't1', `글 ${i}`)
    rememberSent('h', 't1', '글 104')
    rememberSent('h', 't2', '다른 터미널')
    const got = sentHere('h', 't1')
    expect(got).toHaveLength(100)
    expect(got[0]).toBe('글 104')
    expect(got[99]).toBe('글 5')
    expect(sentHere('h', 't2')).toEqual(['다른 터미널'])
    expect(sentHere('g', 't1')).toEqual([])
  })
})
