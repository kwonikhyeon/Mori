import { beforeEach, describe, expect, it } from 'vitest'
import { folder, linkedHost, status, term } from '../../test/fixtures'
import { apply, applyOverview, conn, core, folders, host, hosts, hostsReady, makeStore, presets, ready, resetStore, terminals } from './store'

beforeEach(() => resetStore())

describe('apply', () => {
  it('takes the whole state from a snapshot', () => {
    apply({ type: 'snapshot', core: { connected: true, version: '0.5.0' }, folders: [folder()], terminals: [term(), term({ address: 't2' })] })
    expect([...terminals.value.keys()]).toEqual(['t1', 't2'])
    expect(folders.value.map((f) => f.id)).toEqual(['f1'])
    expect(core.value).toEqual({ connected: true, version: '0.5.0' })
    expect(ready.value).toBe(true)
  })

  it('drops what a new snapshot no longer has', () => {
    apply({ type: 'snapshot', core: { connected: true }, folders: [folder(), folder({ id: 'f2' })], terminals: [term(), term({ address: 't2' })] })
    apply({ type: 'terminal', terminal: term({ address: 't3' }) })
    apply({ type: 'snapshot', core: { connected: false }, folders: [folder({ id: 'f2' })], terminals: [term({ address: 't2', title: 'new' })] })
    expect([...terminals.value.keys()]).toEqual(['t2'])
    expect(terminals.value.get('t2')?.title).toBe('new')
    expect(folders.value.map((f) => f.id)).toEqual(['f2'])
    expect(core.value.connected).toBe(false)
  })

  it('puts in a changed terminal and takes out a removed one', () => {
    apply({ type: 'snapshot', core: { connected: true }, folders: [], terminals: [term()] })
    const before = terminals.value
    apply({ type: 'terminal', terminal: term({ status: status('blocked') }) })
    expect(terminals.value).not.toBe(before)
    expect(terminals.value.get('t1')?.status?.state).toBe('blocked')
    apply({ type: 'terminal', terminal: term({ address: 'machine/t7' }) })
    expect(terminals.value.has('machine/t7')).toBe(true)
    apply({ type: 'removed', address: 't1' })
    expect([...terminals.value.keys()]).toEqual(['machine/t7'])
  })

  it('leaves the map alone when a removed terminal is not there', () => {
    apply({ type: 'snapshot', core: { connected: true }, folders: [], terminals: [term()] })
    const before = terminals.value
    apply({ type: 'removed', address: 'nope' })
    expect(terminals.value).toBe(before)
  })

  it('follows the folders and the core', () => {
    apply({ type: 'folders', folders: [folder({ name: 'Renamed' })] })
    expect(folders.value[0].name).toBe('Renamed')
    apply({ type: 'core', connected: false, error: 'hc not found' })
    expect(core.value).toEqual({ connected: false, error: 'hc not found' })
  })

  it('ignores a ping', () => {
    const before = terminals.value
    apply({ type: 'ping' })
    expect(terminals.value).toBe(before)
  })
})

describe('applyOverview', () => {
  it('keeps the host, presets and hosts', () => {
    applyOverview({
      host: { name: 'macmini', version: '0.1.0' },
      core: { connected: true },
      folders: [folder()],
      terminals: [],
      presets: [{ id: 'shell', name: '셸', argv: [], task: false }],
      hosts: [linkedHost({ name: 'desktop', url: 'https://desktop.example.ts.net' })],
    })
    expect(host.value).toEqual({ name: 'macmini', version: '0.1.0' })
    expect(presets.value.map((p) => p.id)).toEqual(['shell'])
  })
})

describe('resetStore', () => {
  it('starts from nothing', () => {
    apply({ type: 'snapshot', core: { connected: true }, folders: [folder()], terminals: [term()] })
    conn.value = 'open'
    resetStore()
    expect(terminals.value.size).toBe(0)
    expect(ready.value).toBe(false)
    expect(conn.value).toBe('connecting')
  })
})

describe('makeStore', () => {
  it('takes the host list from the hub only', () => {
    const o = { host: { name: 'desk', version: '0.11.0' }, core: { connected: true }, folders: [], terminals: [], presets: [], hosts: [linkedHost()] }
    makeStore().applyOverview(o)
    expect(hosts.value).toEqual([])
    expect(hostsReady.value).toBe(false)
    applyOverview(o)
    expect(hosts.value.map((h) => h.id)).toEqual(['h_desk0001'])
    expect(hostsReady.value).toBe(true)
    resetStore()
    expect(hosts.value).toEqual([])
    expect(hostsReady.value).toBe(false)
  })
})
