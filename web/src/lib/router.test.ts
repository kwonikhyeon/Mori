import { describe, expect, it } from 'vitest'
import { href, parseHash, plainClick, type Route } from './router'

describe('parseHash', () => {
  it('reads every screen', () => {
    expect(parseHash('')).toEqual({ name: 'queue' })
    expect(parseHash('#/')).toEqual({ name: 'queue' })
    expect(parseHash('#/folders')).toEqual({ name: 'folders' })
    expect(parseHash('#/settings')).toEqual({ name: 'settings' })
    expect(parseHash('#/new?folder=f1&wt=%2Fr.wt%2Fx')).toEqual({ name: 'new', folder: 'f1', wt: '/r.wt/x' })
    expect(parseHash('#/new')).toEqual({ name: 'new' })
    expect(parseHash('#/t/t1')).toEqual({ name: 'terminal', addr: 't1', git: false })
    expect(parseHash('#/t/machine%2Ft7/git')).toEqual({ name: 'terminal', addr: 'machine/t7', git: true })
    expect(parseHash('#/git/f1?path=%2Fr')).toEqual({ name: 'git', folder: 'f1', path: '/r' })
    expect(parseHash('#/graph/f1?path=%2Fr&head=1&c=abc')).toEqual({ name: 'graph', folder: 'f1', path: '/r', head: true, c: 'abc' })
    expect(parseHash('#/graph/f1')).toEqual({ name: 'graph', folder: 'f1', head: false })
  })

  it('falls back to the queue for what it does not know', () => {
    expect(parseHash('#/nope')).toEqual({ name: 'queue' })
    expect(parseHash('#/t/')).toEqual({ name: 'queue' })
    expect(parseHash('#/t/%E0%A4%A')).toEqual({ name: 'queue' }) // broken escape
    expect(parseHash('#/t/a/b/c')).toEqual({ name: 'queue' })
  })
})

describe('href', () => {
  const routes: Route[] = [
    { name: 'queue' },
    { name: 'folders' },
    { name: 'settings' },
    { name: 'new', folder: 'f1', wt: '/Users/me/내 프로젝트.wt/feat-x' },
    { name: 'terminal', addr: 'machine/t7', git: false },
    { name: 'terminal', addr: 'machine/t7', git: true },
    { name: 'terminal', addr: '터미널 1', git: false },
    { name: 'git', folder: 'f1', path: '/Users/me/내 프로젝트' },
    { name: 'graph', folder: 'f 1', path: 'C:\\Users\\me\\a+b & c', head: true, c: 'a'.repeat(40) },
    { name: 'graph', folder: 'f1', head: false },
  ]

  it('round-trips every route', () => {
    for (const r of routes) expect(parseHash(href(r))).toEqual(r)
  })

  it('keeps a / of an address inside its segment', () => {
    expect(href({ name: 'terminal', addr: 'machine/t7', git: true })).toBe('#/t/machine%2Ft7/git')
    expect(href({ name: 'queue' })).toBe('#/')
  })

  it('matches the url a notification opens', () => {
    expect(parseHash(new URL('https://macmini.example.ts.net/#/t/machine%2Ft7').hash)).toEqual({ name: 'terminal', addr: 'machine/t7', git: false })
  })
})

describe('plainClick', () => {
  const click = (init: MouseEventInit = {}) => new MouseEvent('click', { button: 0, ...init })

  it('is the main button with no key held', () => {
    expect(plainClick(click())).toBe(true)
  })

  it('leaves the other ways of opening a link to the browser', () => {
    for (const k of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey']) expect(plainClick(click({ [k]: true }))).toBe(false)
    expect(plainClick(click({ button: 1 }))).toBe(false)
  })
})

describe('another host', () => {
  it('reads a route under #/h/<ID>', () => {
    expect(parseHash('#/h/h_1/t/machine%2Ft7')).toEqual({ name: 'terminal', addr: 'machine/t7', git: false, host: 'h_1' })
    expect(parseHash('#/h/h_1')).toEqual({ name: 'queue', host: 'h_1' })
    expect(parseHash('#/h/h_1/settings')).toEqual({ name: 'settings', host: 'h_1' })
  })

  it('writes a host route back to the same hash', () => {
    const routes: Route[] = [
      { name: 'queue', host: 'h_1' },
      { name: 'terminal', addr: 'machine/t7', git: true, host: 'h_1' },
      { name: 'terminal', addr: 't1', git: false, host: 'h 1' },
      { name: 'graph', folder: 'f1', path: '/r', head: true, c: 'abc', host: 'h_1' },
      { name: 'new', folder: 'f1', host: 'h_1' },
    ]
    for (const r of routes) expect(parseHash(href(r))).toEqual(r)
    expect(href({ name: 'queue', host: 'h_1' })).toBe('#/h/h_1')
    expect(href({ name: 'terminal', addr: 't1', git: false, host: 'h 1' })).toBe('#/h/h%201/t/t1')
    expect(href({ name: 'folders', host: '' })).toBe('#/folders')
  })

  it("takes a host route it does not know for the hub's queue", () => {
    for (const h of ['#/h', '#/h/', '#/h/h_1/모르는것', '#/h/h_1/h/h_2', '#/h//t/t1']) expect(parseHash(h)).toEqual({ name: 'queue' })
  })

  it('opens the terminal of a relayed notification', () => {
    const hash = new URL('https://macmini.example.ts.net/#/h/h_desk0001/t/machine%2Ft7').hash
    expect(parseHash(hash)).toEqual({ name: 'terminal', addr: 'machine/t7', git: false, host: 'h_desk0001' })
  })
})
