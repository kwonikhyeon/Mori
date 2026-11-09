import { describe, expect, it } from 'vitest'
import { otherHosts } from './hosts'

describe('otherHosts', () => {
  it('leaves out this host and what is not a web address', () => {
    const hs = [
      { name: 'macmini', url: 'https://macmini.example.ts.net' },
      { name: 'desktop', url: 'https://desktop.example.ts.net/' },
      { name: 'broken', url: 'not a url' },
      { name: 'script', url: 'javascript:alert(1)' },
    ]
    expect(otherHosts(hs, 'https://macmini.example.ts.net').map((h) => h.name)).toEqual(['desktop'])
  })
})
