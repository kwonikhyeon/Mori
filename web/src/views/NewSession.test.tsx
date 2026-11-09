import { cleanup, fireEvent, render, screen, within } from '@testing-library/preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { folder, term, worktree } from '../../test/fixtures'
import { route } from '../lib/router'
import { folders, presets, ready, resetStore, terminals } from '../lib/store'
import type { Branches, Preset, TerminalView } from '../lib/types'
import { NewSession } from './NewSession'

interface Call {
  method: string
  url: string
  body: unknown
}

let calls: Call[] = []
let reply: (c: Call) => Response | undefined = () => undefined

const sent = (path: string, method = 'POST') => calls.filter((c) => c.url === path && c.method === method)

const PRESETS: Preset[] = [
  { id: 'claude', name: 'Claude Code', argv: ['claude'], task: true },
  { id: 'codex', name: 'Codex', argv: ['codex'], task: true },
  { id: 'shell', name: '셸', argv: [], task: false },
]

const WT = '/Users/me/dev/Mori.wt/ui-candidates'
const NEW_WT = '/Users/me/dev/Mori.wt/fix-notify-dup'
const mori = () =>
  folder({ worktrees: [worktree(), worktree({ path: WT, branch: 'ui/candidates', main: false, head: 'b'.repeat(40) })] })
const notes = () => folder({ id: 'f2', name: 'notes', path: '/Users/me/notes', repo: false, worktrees: [] })

const BRANCHES: Branches = {
  local: [
    { name: 'main', head: 'a', current: true, remote: false },
    { name: 'old', head: 'c', current: false, remote: false },
    { name: 'ui/candidates', head: 'b', current: false, remote: false },
  ],
  remote: [
    { name: 'origin/main', head: 'a', current: false, remote: true },
    { name: 'origin/pr-7', head: 'd', current: false, remote: true },
  ],
}

const made: TerminalView = term({ address: 't9', display_title: '새 세션' })

function live(addr: string, wt: string): TerminalView {
  return term({ address: addr, worktree: wt })
}

const submit = () => fireEvent.click(screen.getByRole('button', { name: '세션 만들기' }))
const radio = (name: RegExp) => screen.getByRole('radio', { name }) as HTMLInputElement
const summary = () => document.querySelector('.ns-sum')!.textContent

/** Answers the branch list, the new worktree and the session. */
function serve(over: (c: Call) => Response | undefined = () => undefined) {
  reply = (c) =>
    over(c) ??
    (c.url === '/api/folders/f1/branches'
      ? Response.json(BRANCHES)
      : c.url === '/api/folders/f1/worktrees'
        ? Response.json(worktree({ path: NEW_WT, branch: (c.body as { branch: string }).branch, main: false }), { status: 201 })
        : c.url === '/api/terminals'
          ? Response.json(made, { status: 201 })
          : undefined)
}

/** Picks 새 브랜치 and waits for the branches it bases on. */
async function newBranch(name: string) {
  fireEvent.click(radio(/새 브랜치/))
  const base = (await screen.findByLabelText('기준')) as HTMLSelectElement
  await vi.waitFor(() => expect(base.options.length).toBeGreaterThan(1))
  fireEvent.input(screen.getByLabelText('브랜치 이름'), { target: { value: name } })
  return base
}

beforeEach(() => {
  calls = []
  reply = () => undefined
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const raw = init.body
      const c = { method: init.method ?? 'GET', url: String(url), body: typeof raw === 'string' ? JSON.parse(raw) : undefined }
      calls.push(c)
      return reply(c) ?? Response.json({})
    }),
  )
  localStorage.clear()
  folders.value = [mori(), notes()]
  presets.value = PRESETS
  terminals.value = new Map([live('t1', '/Users/me/dev/Mori'), live('t2', '/Users/me/dev/Mori'), live('t3', WT)].map((t) => [t.address, t]))
  ready.value = true
  history.replaceState(null, '', '/#/new')
  route.value = { name: 'new' }
})

afterEach(() => {
  cleanup()
  resetStore()
  localStorage.clear()
  route.value = { name: 'queue' }
  vi.unstubAllGlobals()
})

describe('NewSession', () => {
  it('starts the session in the folder and worktree it was opened for', async () => {
    serve()
    render(<NewSession variant="pc" folder="f1" wt={WT} />)
    expect(screen.getByRole('button', { name: /^폴더 Mori/ })).toBeTruthy()
    expect(radio(/ui\/candidates/).checked).toBe(true)
    expect(radio(/^main/).closest('label')!.textContent).toContain('세션 2')
    expect(radio(/ui\/candidates/).closest('label')!.textContent).toContain('세션 1')
    expect(radio(/Claude Code/).checked).toBe(true)
    expect(summary()).toBe('Mori · ui/candidates · Claude Code')

    fireEvent.input(screen.getByLabelText('작업'), { target: { value: '  알림 중복 억제 테스트  ' } })
    submit()
    await vi.waitFor(() => expect(route.value).toEqual({ name: 'terminal', addr: 't9', git: false }))
    expect(sent('/api/terminals')[0].body).toEqual({ folder_id: 'f1', preset: 'claude', worktree: WT, task: '알림 중복 억제 테스트' })
    expect(location.hash).toBe('#/t/t9')
    // The list has it before the event stream does.
    expect(terminals.value.get('t9')?.display_title).toBe('새 세션')
  })

  it('takes no task for a program without one and remembers the choice', async () => {
    serve()
    render(<NewSession variant="pc" folder="f2" />)
    expect(screen.queryByRole('group', { name: '워크트리' })).toBeNull()
    fireEvent.click(radio(/셸/))
    expect(screen.queryByLabelText('작업')).toBeNull()
    const name = screen.getByLabelText(/^이름/)
    expect(name.getAttribute('placeholder')).toBe('비우면 셸')
    fireEvent.input(name, { target: { value: '메모' } })
    expect(summary()).toBe('notes · 셸')
    submit()
    await vi.waitFor(() => expect(route.value.name).toBe('terminal'))
    expect(sent('/api/terminals')[0].body).toEqual({ folder_id: 'f2', preset: 'shell', title: '메모' })

    cleanup()
    render(<NewSession variant="pc" />)
    expect(screen.getByRole('button', { name: /^폴더 notes/ })).toBeTruthy()
    expect(radio(/셸/).checked).toBe(true)
  })

  it('makes the worktree of a new branch, then the session in it', async () => {
    serve()
    render(<NewSession variant="pc" folder="f1" />)
    expect(radio(/^main/).checked).toBe(true)
    const base = await newBranch('fix/notify-dup')
    expect(base.value).toBe('main')
    expect(screen.getByText('~/dev/Mori.wt/fix-notify-dup')).toBeTruthy()
    expect(summary()).toBe('Mori · 새 브랜치 fix/notify-dup · Claude Code')
    submit()
    await vi.waitFor(() => expect(route.value.name).toBe('terminal'))
    expect(sent('/api/folders/f1/worktrees')[0].body).toEqual({ branch: 'fix/notify-dup', create: true, base: 'main' })
    expect(sent('/api/terminals')[0].body).toEqual({ folder_id: 'f1', preset: 'claude', worktree: NEW_WT })
  })

  it('keeps the new worktree chosen when the session fails', async () => {
    let down = true
    serve((c) =>
      c.url === '/api/terminals' && down
        ? Response.json({ error: { kind: 'core_unavailable', message: '코어에 연결되지 않았습니다' } }, { status: 503 })
        : undefined,
    )
    render(<NewSession variant="pc" folder="f1" />)
    await newBranch('fix/notify-dup')
    submit()
    expect((await screen.findByRole('alert')).textContent).toContain('코어에 연결되지 않았습니다')
    expect(radio(/fix\/notify-dup/).checked).toBe(true)

    down = false
    submit()
    await vi.waitFor(() => expect(route.value.name).toBe('terminal'))
    expect(sent('/api/folders/f1/worktrees')).toHaveLength(1)
    expect(sent('/api/terminals')[1].body).toMatchObject({ worktree: NEW_WT })
  })

  it('says why a branch cannot be made', async () => {
    // Only git knows: a branch fix is there, so fix/a cannot be.
    serve((c) =>
      c.url === '/api/folders/f1/worktrees'
        ? Response.json(
            { error: { kind: 'git_failed', message: "fatal: cannot lock ref 'refs/heads/fix/a': 'refs/heads/fix' exists" } },
            { status: 422 },
          )
        : undefined,
    )
    render(<NewSession variant="pc" folder="f1" />)
    await newBranch('fix/a')
    submit()
    expect((await screen.findByRole('alert')).textContent).toContain('브랜치를 만들지 못했습니다')
    expect(sent('/api/terminals')).toHaveLength(0)
    expect(radio(/새 브랜치/).checked).toBe(true)
  })

  it('opens a branch that has no worktree and refuses one that has', async () => {
    serve()
    render(<NewSession variant="pc" folder="f1" />)
    const base = await newBranch('ui/candidates')
    expect(screen.getByText(/이미 워크트리가 있는 브랜치입니다/)).toBeTruthy()
    expect((screen.getByRole('button', { name: '세션 만들기' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.input(screen.getByLabelText('브랜치 이름'), { target: { value: 'pr-7' } })
    expect(document.querySelector('.ns-hint')!.textContent).toBe('~/dev/Mori.wt/pr-7에 만듭니다 · origin/pr-7 추적')
    fireEvent.input(screen.getByLabelText('브랜치 이름'), { target: { value: 'old' } })
    expect(document.querySelector('.ns-hint')!.textContent).toBe('기존 브랜치를 ~/dev/Mori.wt/old에 엽니다')
    expect(base.disabled).toBe(true)
    submit()
    await vi.waitFor(() => expect(route.value.name).toBe('terminal'))
    expect(sent('/api/folders/f1/worktrees')[0].body).toEqual({ branch: 'old', create: false })
  })

  it('says at once why git would not take a name', async () => {
    serve()
    render(<NewSession variant="pc" folder="f1" />)
    const base = await newBranch('smoke/new wt')
    const hint = document.querySelector('.ns-hint')!
    expect(hint.textContent).toBe('브랜치 이름에 공백은 쓸 수 없습니다')
    expect(hint.classList.contains('is-bad')).toBe(true)
    // Still typing: the base stays free.
    expect(base.disabled).toBe(false)
    expect((screen.getByRole('button', { name: '세션 만들기' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.submit(base.form!)
    expect(sent('/api/folders/f1/worktrees')).toHaveLength(0)

    fireEvent.input(screen.getByLabelText('브랜치 이름'), { target: { value: 'smoke/new-wt' } })
    expect(hint.textContent).toBe('~/dev/Mori.wt/smoke-new-wt에 만듭니다')
    expect(hint.classList.contains('is-bad')).toBe(false)

    // A branch is a file under refs/heads: old cannot have old/x beside it.
    fireEvent.input(screen.getByLabelText('브랜치 이름'), { target: { value: 'old/x' } })
    expect(hint.textContent).toBe('‘old’ 브랜치가 있어서 이 이름은 쓸 수 없습니다')
    fireEvent.input(screen.getByLabelText('브랜치 이름'), { target: { value: 'ui' } })
    expect(hint.textContent).toBe('‘ui/candidates’ 브랜치가 있어서 이 이름은 쓸 수 없습니다')
    expect(hint.classList.contains('is-bad')).toBe(true)
  })

  it('picks another registered folder', async () => {
    render(<NewSession variant="pc" folder="f1" />)
    fireEvent.click(screen.getByRole('button', { name: /^폴더 Mori/ }))
    const sheet = screen.getByRole('dialog', { name: '폴더 고르기' })
    expect(within(sheet).getByRole('button', { name: /Mori/ }).getAttribute('aria-current')).toBe('true')
    fireEvent.click(within(sheet).getByRole('button', { name: /notes/ }))
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByRole('button', { name: /^폴더 notes/ })).toBeTruthy()
    expect(screen.queryByRole('group', { name: '워크트리' })).toBeNull()
  })

  it('asks for a folder when none is registered', async () => {
    folders.value = []
    reply = (c) => (c.url.startsWith('/api/fs') ? Response.json({ path: '/Users/me', parent: '/Users', entries: [], truncated: false }) : undefined)
    render(<NewSession variant="pc" />)
    expect((screen.getByRole('button', { name: '세션 만들기' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /^폴더 폴더를 고르세요/ }))
    expect(screen.getByRole('dialog', { name: '폴더 추가' })).toBeTruthy()
  })

  it('goes back to the tab it came from on a phone', () => {
    render(<NewSession variant="phone" back="#/folders" />)
    expect(screen.getByRole('link', { name: '뒤로' }).getAttribute('href')).toBe('#/folders')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('새 세션')
  })
})
