import { describe, expect, it } from 'vitest'
import { linkedHost } from '../../test/fixtures'
import { isHere, otherHosts } from './hosts'

describe('otherHosts', () => {
  it('leaves out this host and what is not a web address', () => {
    const hs = [
      linkedHost({ name: 'macmini', url: 'https://macmini.example.ts.net' }),
      linkedHost({ name: 'desktop', url: 'https://desktop.example.ts.net/' }),
      linkedHost({ name: 'broken', url: 'not a url' }),
      linkedHost({ name: 'script', url: 'javascript:alert(1)' }),
    ]
    expect(otherHosts(hs, 'https://macmini.example.ts.net').map((h) => h.name)).toEqual(['desktop'])
  })
})

describe('isHere', () => {
  it('tells a link to this page from one to another host', () => {
    const here = 'https://macmini.example.ts.net'
    expect(isHere('https://macmini.example.ts.net/pair', here)).toBe(true)
    expect(isHere('https://desk.example.ts.net', here)).toBe(false)
    expect(isHere('not a url', here)).toBe(false)
  })
})
