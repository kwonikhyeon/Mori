import { cleanup, fireEvent, render, screen, within } from '@testing-library/preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { folder } from '../../test/fixtures'
import { folders, presets, resetStore } from '../lib/store'
import { toasts } from '../lib/toast'
import type { FolderView, Preset } from '../lib/types'
import { FoldersCard, PresetsCard } from './SettingsEdit'

interface Call {
  method: string
  path: string
  body: unknown
}

let calls: Call[] = []
let reply: (c: Call) => Response | undefined = () => undefined

const sent = (method: string) => calls.filter((c) => c.method === method)
const toastTexts = () => toasts.value.map((t) => [t.text, t.kind])
const fail = (status: number, message: string) => Response.json({ error: { kind: 'invalid', message } }, { status })
const button = (name: string) => screen.getByRole('button', { name })
const textbox = (where: HTMLElement, name: string) => within(where).getByRole('textbox', { name }) as HTMLInputElement
const type = (el: HTMLInputElement, value: string) => fireEvent.input(el, { target: { value } })
const save = () => fireEvent.click(button('저장'))

const site: FolderView = folder({ id: 'f2', name: 'site', path: '/Users/me/dev/site', repo: false, worktrees: [] })

beforeEach(() => {
  calls = []
  reply = () => undefined
  toasts.value = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const u = new URL(String(url), 'http://mori.test')
      const raw = init.body
      const c = { method: init.method ?? 'GET', path: u.pathname, body: typeof raw === 'string' ? JSON.parse(raw) : undefined }
      calls.push(c)
      return reply(c) ?? Response.json({})
    }),
  )
})

afterEach(() => {
  cleanup()
  resetStore()
  toasts.value = []
  vi.unstubAllGlobals()
})

describe('FoldersCard', () => {
  beforeEach(() => {
    folders.value = [folder(), site]
  })

  it('renames a folder in its row, and gives the focus back to the row', async () => {
    reply = (c) => (c.method === 'PATCH' ? Response.json({ ...folder(), name: (c.body as { name: string }).name }) : undefined)
    render(<FoldersCard />)
    expect(screen.getByRole('heading', { name: '폴더 2' })).toBeTruthy()
    expect(screen.getByText('~/dev/Mori')).toBeTruthy()

    fireEvent.click(button('Mori 이름 바꾸기'))
    const name = screen.getByRole('textbox', { name: 'Mori 새 이름' }) as HTMLInputElement
    expect(document.activeElement).toBe(name)
    expect(name.value).toBe('Mori')
    // An empty name gives the folder its own name back.
    expect(screen.getByText('비우면 폴더 이름 Mori(으)로 돌아갑니다.').id).toBe(name.getAttribute('aria-describedby'))

    type(name, '  몰이 ')
    fireEvent.submit(name.form!)
    await vi.waitFor(() => expect(document.activeElement).toBe(button('몰이 이름 바꾸기')))
    expect(sent('PATCH')).toEqual([{ method: 'PATCH', path: '/api/folders/f1', body: { name: '몰이' } }])
    expect(folders.value.map((f) => f.name)).toEqual(['몰이', 'site'])
    expect(screen.queryByRole('textbox')).toBeNull()
    // Renaming says nothing more: the row shows it.
    expect(toasts.value).toEqual([])
  })

  it('asks nothing of the server for the same name, and lets Escape go back', async () => {
    render(<FoldersCard />)
    fireEvent.click(button('site 이름 바꾸기'))
    fireEvent.click(button('저장'))
    await vi.waitFor(() => expect(document.activeElement).toBe(button('site 이름 바꾸기')))

    fireEvent.click(button('site 이름 바꾸기'))
    const name = screen.getByRole('textbox', { name: 'site 새 이름' }) as HTMLInputElement
    type(name, 'web')
    fireEvent.keyDown(name, { key: 'Escape' })
    await vi.waitFor(() => expect(document.activeElement).toBe(button('site 이름 바꾸기')))
    expect(calls).toEqual([])
    expect(folders.value.map((f) => f.name)).toEqual(['Mori', 'site'])
  })

  it('keeps the name being typed when the server turns it down', async () => {
    reply = (c) => (c.method === 'PATCH' ? fail(400, '폴더 이름은 100자까지입니다') : undefined)
    render(<FoldersCard />)
    fireEvent.click(button('Mori 이름 바꾸기'))
    type(screen.getByRole('textbox', { name: 'Mori 새 이름' }) as HTMLInputElement, '몰이')
    save()
    await vi.waitFor(() => expect(toastTexts()).toEqual([['폴더 이름은 100자까지입니다', 'error']]))
    expect((screen.getByRole('textbox', { name: 'Mori 새 이름' }) as HTMLInputElement).value).toBe('몰이')
    expect(folders.value.map((f) => f.name)).toEqual(['Mori', 'site'])
  })

  it('takes a folder off the list after asking, and leaves the focus on adding one', async () => {
    reply = (c) => (c.method === 'DELETE' ? new Response(null, { status: 204 }) : undefined)
    render(<FoldersCard />)
    fireEvent.click(button('Mori 목록에서 빼기'))
    const ask = screen.getByRole('dialog', { name: '폴더를 목록에서 뺄까요?' })
    expect(ask.textContent).toContain('Mori 폴더를 Mori 목록에서 뺍니다. 폴더 안의 파일과 워크트리, 열린 세션은 그대로 남습니다.')
    fireEvent.click(within(ask).getByRole('button', { name: '목록에서 빼기' }))

    await vi.waitFor(() => expect(toastTexts()).toEqual([['Mori 폴더를 목록에서 뺐습니다', 'info']]))
    expect(sent('DELETE').map((c) => c.path)).toEqual(['/api/folders/f1'])
    expect(folders.value.map((f) => f.id)).toEqual(['f2'])
    expect(screen.getByRole('heading', { name: '폴더 1' })).toBeTruthy()
    await vi.waitFor(() => expect(document.activeElement).toBe(button('폴더 추가')))
  })

  it('keeps the folder when it cannot be taken off', async () => {
    reply = (c) => (c.method === 'DELETE' ? fail(404, '없는 폴더입니다: f1') : undefined)
    render(<FoldersCard />)
    fireEvent.click(button('Mori 목록에서 빼기'))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '목록에서 빼기' }))
    await vi.waitFor(() => expect(toastTexts()).toEqual([['없는 폴더입니다: f1', 'error']]))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(folders.value.map((f) => f.id)).toEqual(['f1', 'f2'])
  })

  it('adds a folder by browsing to it', async () => {
    const dev = folder({ id: 'f9', name: 'dev', path: '/Users/me/dev', repo: false, worktrees: [] })
    reply = (c) => {
      if (c.path === '/api/fs') {
        const entries = [folder(), site].map((f) => ({ name: f.name, path: f.path, git: f.repo }))
        return Response.json({ path: '/Users/me/dev', parent: '/Users/me', entries, truncated: false })
      }
      if (c.path === '/api/folders' && c.method === 'POST') return Response.json(dev, { status: 201 })
      return undefined
    }
    render(<FoldersCard />)
    fireEvent.click(button('폴더 추가'))
    const picker = screen.getByRole('dialog', { name: '폴더 추가' })
    // Only browsing: there is no list of the folders to go back to.
    expect(within(picker).queryByRole('button', { name: '등록된 폴더로' })).toBeNull()
    await within(picker).findByRole('list', { name: '~/dev의 폴더' })
    fireEvent.click(within(picker).getByRole('button', { name: '이 폴더 등록' }))

    await vi.waitFor(() => expect(toastTexts()).toEqual([['dev 폴더를 등록했습니다', 'info']]))
    expect(sent('POST')).toEqual([{ method: 'POST', path: '/api/folders', body: { path: '/Users/me/dev', name: '' } }])
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('heading', { name: '폴더 3' })).toBeTruthy()
  })

  it('says when there is none', () => {
    folders.value = []
    render(<FoldersCard />)
    expect(screen.getByRole('heading', { name: '폴더 0' })).toBeTruthy()
    expect(screen.getByText('등록된 폴더가 없습니다.')).toBeTruthy()
  })
})

describe('PresetsCard', () => {
  const claude: Preset = { id: 'claude', name: 'Claude Code', argv: ['claude'], task: true }
  const shell: Preset = { id: 'shell', name: '셸', argv: [], task: false }
  const dev: Preset = { id: 'dev', name: 'Dev', argv: ['npm', 'run', 'dev -- --host'], task: false }

  beforeEach(() => {
    presets.value = [claude, shell, dev]
  })

  it('shows each command as one would type it', () => {
    render(<PresetsCard />)
    expect(screen.getByRole('heading', { name: '프리셋 3' })).toBeTruthy()
    const row = (name: string) => screen.getByText(name).closest('.st-row') as HTMLElement
    expect(within(row('Claude Code')).getByText('작업 받음')).toBeTruthy()
    expect(within(row('Claude Code')).getByText('claude')).toBeTruthy()
    expect(within(row('셸')).getByText('이 컴퓨터의 셸')).toBeTruthy()
    expect(within(row('Dev')).getByText('npm run "dev -- --host"')).toBeTruthy()
    expect(screen.getAllByText('작업 받음')).toHaveLength(1)
  })

  it('edits them all, adds one, and saves the list as a whole', async () => {
    const back = (c: Call) => Response.json(c.body)
    reply = (c) => (c.method === 'PUT' ? back(c) : undefined)
    render(<PresetsCard />)
    fireEvent.click(button('편집'))
    const first = screen.getByRole('group', { name: 'Claude Code' })
    await vi.waitFor(() => expect(document.activeElement).toBe(textbox(first, '이름')))
    expect(textbox(first, 'id').value).toBe('claude')
    expect(textbox(first, '명령').value).toBe('claude')
    expect(textbox(first, '명령').getAttribute('aria-describedby')).toBe(
      screen.getAllByText('비우면 이 컴퓨터의 셸을 엽니다. 공백이 든 인수는 따옴표로 묶습니다.')[0].id,
    )
    expect((within(first).getByRole('checkbox', { name: '작업을 받음' }) as HTMLInputElement).checked).toBe(true)
    expect(textbox(screen.getByRole('group', { name: 'Dev' }), '명령').value).toBe('npm run "dev -- --host"')

    fireEvent.click(button('프리셋 추가'))
    const added = screen.getByRole('group', { name: '프리셋 4' })
    await vi.waitFor(() => expect(document.activeElement).toBe(textbox(added, '이름')))
    expect(textbox(added, 'id').value).toBe('preset-1')
    type(textbox(added, '이름'), 'Codex')
    // The group takes the name it is given.
    expect(screen.getByRole('group', { name: 'Codex' })).toBe(added)
    type(textbox(added, '명령'), `codex --model 'gpt 5'`)
    fireEvent.click(within(added).getByRole('checkbox', { name: '작업을 받음' }))
    fireEvent.click(button('Dev 빼기'))

    save()
    await vi.waitFor(() => expect(toastTexts()).toEqual([['프리셋을 저장했습니다', 'info']]))
    const out = [claude, shell, { id: 'preset-1', name: 'Codex', argv: ['codex', '--model', 'gpt 5'], task: true }]
    expect(sent('PUT')).toEqual([{ method: 'PUT', path: '/api/presets', body: out }])
    expect(presets.value).toEqual(out)
    expect(screen.getByRole('heading', { name: '프리셋 3' })).toBeTruthy()
    await vi.waitFor(() => expect(document.activeElement).toBe(button('편집')))
  })

  it('gives a new one the first id not taken', () => {
    presets.value = [{ ...claude, id: 'preset-1' }]
    render(<PresetsCard />)
    fireEvent.click(button('편집'))
    fireEvent.click(button('프리셋 추가'))
    fireEvent.click(button('프리셋 추가'))
    expect(screen.getAllByRole('textbox', { name: 'id' }).map((i) => (i as HTMLInputElement).value)).toEqual(['preset-1', 'preset-2', 'preset-3'])
  })

  it('stops at a quote left open, before asking the server', async () => {
    render(<PresetsCard />)
    fireEvent.click(button('편집'))
    type(textbox(screen.getByRole('group', { name: 'Dev' }), '명령'), 'npm run "dev')
    save()
    expect((await screen.findByRole('alert')).textContent).toBe('프리셋 Dev: 명령의 따옴표가 닫히지 않았습니다')
    expect(calls).toEqual([])
  })

  it('shows what the server said, and stays in the form', async () => {
    reply = (c) => (c.method === 'PUT' ? fail(400, '프리셋 id "Dev": 영문 소문자, 숫자, _, -로 1~32자여야 합니다') : undefined)
    render(<PresetsCard />)
    fireEvent.click(button('편집'))
    type(textbox(screen.getByRole('group', { name: 'Dev' }), 'id'), 'Dev')
    save()
    expect((await screen.findByRole('alert')).textContent).toBe('프리셋 id "Dev": 영문 소문자, 숫자, _, -로 1~32자여야 합니다')
    expect(textbox(screen.getByRole('group', { name: 'Dev' }), 'id').value).toBe('Dev')
    expect(presets.value).toEqual([claude, shell, dev])
  })
})
