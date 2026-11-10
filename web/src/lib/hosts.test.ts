import { describe, expect, it } from 'vitest'
import { isHere } from './hosts'

describe('isHere', () => {
  it('tells a link to this page from one to another host', () => {
    const here = 'https://macmini.example.ts.net'
    expect(isHere('https://macmini.example.ts.net/pair', here)).toBe(true)
    expect(isHere('https://desk.example.ts.net', here)).toBe(false)
    expect(isHere('not a url', here)).toBe(false)
  })
})
