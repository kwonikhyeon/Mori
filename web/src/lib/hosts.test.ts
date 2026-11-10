import { describe, expect, it } from 'vitest'
import { isHere, originOf } from './hosts'

describe('isHere', () => {
  it('tells a link to this page from one to another host', () => {
    const here = 'https://macmini.example.ts.net'
    expect(isHere('https://macmini.example.ts.net/pair', here)).toBe(true)
    expect(isHere('https://desk.example.ts.net', here)).toBe(false)
    expect(isHere('not a url', here)).toBe(false)
  })
})

describe('originOf', () => {
  // As the hub reads a host's address (internal/peer ParseTarget).
  it('reads the origin of an address or a pairing link', () => {
    expect(originOf(' https://Desk.example.ts.net:443/pair#code=ABCD-EFGH ')).toBe('https://desk.example.ts.net')
    expect(originOf('http://desk.example.ts.net:80/')).toBe('http://desk.example.ts.net')
    expect(originOf('https://desk.example.ts.net:8443')).toBe('https://desk.example.ts.net:8443')
    expect(originOf('desk.example.ts.net')).toBe('')
  })
})
