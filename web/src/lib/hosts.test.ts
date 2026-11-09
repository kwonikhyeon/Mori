import { describe, expect, it } from 'vitest'
import { linkedHost } from '../../test/fixtures'
import { otherHosts } from './hosts'

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
