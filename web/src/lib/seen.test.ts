import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { status, term } from '../../test/fixtures'
import { markSeen, resetSeen, seenMarks, unseen } from './seen'

const NOW = 100 * 3_600_000
const MIN = 60_000
const DAY = 24 * 3_600_000

/** A session whose turn ended a while ago and waits for input. */
const done = (over: Parameters<typeof term>[0] = {}) => term({ status: status('done'), status_ms: NOW - 5 * MIN, turn: 2, ...over })

beforeEach(() => {
  localStorage.clear()
  resetSeen()
})

afterEach(() => {
  localStorage.clear()
  resetSeen()
})

describe('unseen', () => {
  it('is a turn that ended and waits for input, not opened here', () => {
    expect(unseen('', done(), NOW)).toBe(true)
    expect(unseen('', done({ status: status('idle') }), NOW)).toBe(true)
  })

  it('is not a session that never worked, works, asks, ended or stopped long ago', () => {
    expect(unseen('', done({ turn: 0 }), NOW)).toBe(false)
    expect(unseen('', done({ status: status('working') }), NOW)).toBe(false)
    expect(unseen('', done({ status: status('blocked') }), NOW)).toBe(false)
    expect(unseen('', done({ state: 'finished' }), NOW)).toBe(false)
    expect(unseen('', done({ status_ms: NOW - DAY - MIN }), NOW)).toBe(false)
    expect(unseen('', done({ status: null, status_ms: null }), NOW)).toBe(false)
  })

  it('goes once the session is seen, and comes back with the next turn', () => {
    markSeen('', done(), NOW)
    expect(unseen('', done(), NOW)).toBe(false)
    expect(unseen('', done({ turn: 3 }), NOW)).toBe(true)
    // seen while it worked on: the turn that ends after is news
    markSeen('', done({ turn: 3, status: status('working') }), NOW)
    expect(unseen('', done({ turn: 4 }), NOW)).toBe(true)
  })

  it('keeps hosts apart and knows a new session at an old address', () => {
    markSeen('', done(), NOW)
    expect(unseen('h_desk0001', done(), NOW)).toBe(true)
    expect(unseen('', done({ created_ms: 9_000 }), NOW)).toBe(true)
  })

  it('remembers on this device and forgets marks after a week', () => {
    markSeen('', done({ address: 't9' }), NOW - 8 * DAY)
    markSeen('', done(), NOW)
    expect(JSON.parse(localStorage.getItem('mori.seen') ?? '{}')).toEqual({ '|t1': { c: 1_000, turn: 2, at: NOW } })
    seenMarks.value = {}
    resetSeen()
    expect(unseen('', done(), NOW)).toBe(false)
  })

  it('reads past what it cannot use', () => {
    localStorage.setItem('mori.seen', JSON.stringify({ '|t1': { c: 1_000, turn: 'x' }, '|t2': 3 }))
    resetSeen()
    expect(seenMarks.value).toEqual({})
  })
})
