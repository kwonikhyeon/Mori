import { cleanup, fireEvent, render, screen } from '@testing-library/preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { folder } from '../../test/fixtures'
import { folders, resetStore } from '../lib/store'
import type { FolderView, FsListing } from '../lib/types'
import { FolderPicker } from './FolderPicker'

interface Call {
  method: string
  path: string
  q: URLSearchParams
  body: unknown
}

let calls: Call[] = []
let reply: (c: Call) => Response | Promise<Response> | undefined = () => undefined

const fsAsked = () => calls.filter((c) => c.path === '/api/fs').map((c) => [c.q.get('path') ?? '', c.q.get('hidden') ?? ''])

function dir(path: string, names: string[] = []): FsListing {
  return {
    path,
    parent: path.slice(0, path.lastIndexOf('/')) || '/',
    entries: names.map((n) => ({ name: n, path: `${path}/${n}`, git: n === 'Mori' })),
    truncated: false,
  }
}

// The home folder is /Users/me.
const DIRS: Record<string, FsListing> = {
  '/Users/me': dir('/Users/me', ['dev', 'notes']),
  '/Users/me/dev': dir('/Users/me/dev', ['Mori', 'site']),
  '/Users/me/dev/site': dir('/Users/me/dev/site'),
  '/Users/me/dev/Mori': dir('/Users/me/dev/Mori', ['docs', 'web']),
}

function fs(c: Call): Response | undefined {
  if (c.path !== '/api/fs') return undefined
  const p = c.q.get('path') || '/Users/me'
  const l = DIRS[p]
  return l ? Response.json(l) : Response.json({ error: { kind: 'not_found', message: `폴더가 없습니다: ${p}` } }, { status: 404 })
}

const mori = () => folder()
const site: FolderView = folder({ id: 'f3', name: 'site', path: '/Users/me/dev/site', repo: false, worktrees: [] })

let pick = vi.fn<(f: FolderView) => void>()
let close = vi.fn<() => void>()

const open = (value?: string) => render(<FolderPicker open value={value} onPick={pick} onClose={close} />)
const listOf = (where: string) => screen.findByRole('list', { name: `${where}의 폴더` })

async function goTo(path: string) {
  const field = screen.getByLabelText('경로') as HTMLInputElement
  fireEvent.input(field, { target: { value: path } })
  fireEvent.submit(field.form!)
}

beforeEach(() => {
  calls = []
  reply = fs
  pick = vi.fn<(f: FolderView) => void>()
  close = vi.fn<() => void>()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const u = new URL(String(url), 'http://mori.test')
      const raw = init.body
      const c = { method: init.method ?? 'GET', path: u.pathname, q: u.searchParams, body: typeof raw === 'string' ? JSON.parse(raw) : undefined }
      calls.push(c)
      return (await reply(c)) ?? Response.json({})
    }),
  )
})

afterEach(() => {
  cleanup()
  resetStore()
  vi.unstubAllGlobals()
})

describe('FolderPicker', () => {
  it('picks a registered folder', () => {
    folders.value = [mori(), site]
    open('f1')
    const now = screen.getByRole('button', { name: /Mori/ })
    expect(now.getAttribute('aria-current')).toBe('true')
    expect(document.activeElement).toBe(now)
    fireEvent.click(screen.getByRole('button', { name: /site/ }))
    expect(pick).toHaveBeenCalledWith(site)
  })

  it('registers a folder of this computer, browsing from beside the chosen one', async () => {
    folders.value = [mori()]
    open('f1')
    fireEvent.click(screen.getByRole('button', { name: '폴더 추가' }))
    expect(screen.getByRole('dialog', { name: '폴더 추가' })).toBeTruthy()
    expect(document.activeElement?.textContent).toBe('폴더 추가')
    await listOf('~/dev')
    expect(fsAsked()).toEqual([['/Users/me/dev', '']])

    fireEvent.click(screen.getByRole('button', { name: /site/ }))
    expect(await screen.findByText('하위 폴더가 없습니다')).toBeTruthy()
    expect((screen.getByLabelText('경로') as HTMLInputElement).value).toBe('/Users/me/dev/site')

    reply = (c) => (c.path === '/api/folders' && c.method === 'POST' ? Response.json(site, { status: 201 }) : fs(c))
    fireEvent.click(screen.getByRole('button', { name: '이 폴더 등록' }))
    await vi.waitFor(() => expect(pick).toHaveBeenCalledWith(site))
    expect(calls.find((c) => c.path === '/api/folders')!.body).toEqual({ path: '/Users/me/dev/site', name: '' })
    // The screen behind has it before the event stream brings it.
    expect(folders.value.map((f) => f.id)).toEqual(['f1', 'f3'])
  })

  it('goes up and to a typed path, and picks a registered folder without adding it', async () => {
    folders.value = [mori()]
    open('f1')
    fireEvent.click(screen.getByRole('button', { name: '폴더 추가' }))
    await listOf('~/dev')
    fireEvent.click(screen.getByRole('button', { name: '위 폴더' }))
    await listOf('~')

    await goTo('/Users/me/dev/Mori')
    await listOf('~/dev/Mori')
    fireEvent.click(screen.getByRole('button', { name: '이 폴더 고르기' }))
    expect(pick).toHaveBeenCalledWith(folders.value[0])
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
  })

  it('says what went wrong and keeps the folder it showed', async () => {
    folders.value = [mori()]
    open('f1')
    fireEvent.click(screen.getByRole('button', { name: '폴더 추가' }))
    await listOf('~/dev')
    await goTo('/nope')
    expect((await screen.findByRole('alert')).textContent).toBe('폴더가 없습니다: /nope')
    expect(screen.getByRole('list', { name: '~/dev의 폴더' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /site/ }))
    await screen.findByText('하위 폴더가 없습니다')
    reply = (c) =>
      c.path === '/api/folders'
        ? Response.json({ error: { kind: 'conflict', message: '이미 등록된 폴더입니다: /Users/me/dev/Mori' } }, { status: 409 })
        : fs(c)
    fireEvent.click(screen.getByRole('button', { name: '이 폴더 등록' }))
    expect((await screen.findByRole('alert')).textContent).toBe('이미 등록된 폴더입니다: /Users/me/dev/Mori')
    expect(pick).not.toHaveBeenCalled()
  })

  it('starts at home with nothing registered and can show hidden folders', async () => {
    folders.value = []
    open()
    expect(screen.getByRole('dialog', { name: '폴더 추가' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '등록된 폴더로' })).toBeNull()
    await listOf('~')
    fireEvent.click(screen.getByRole('checkbox', { name: '숨긴 폴더 보기' }))
    await vi.waitFor(() => expect(fsAsked()).toEqual([['', ''], ['/Users/me', '1']]))
  })

  it('shows the folder asked for last, not the one answered last', async () => {
    folders.value = [mori()]
    let answer!: () => void
    reply = (c) =>
      c.q.get('path') === '/Users/me/dev' ? new Promise<Response>((done) => (answer = () => done(fs(c)!))) : fs(c)
    open('f1')
    fireEvent.click(screen.getByRole('button', { name: '폴더 추가' }))
    await vi.waitFor(() => expect(fsAsked()).toHaveLength(1))
    await goTo('/Users/me')
    await listOf('~')
    answer()
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.getByRole('list', { name: '~의 폴더' })).toBeTruthy()
    expect((screen.getByLabelText('경로') as HTMLInputElement).value).toBe('/Users/me')
  })
})
