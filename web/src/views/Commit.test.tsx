import { cleanup, fireEvent, render, screen, within } from '@testing-library/preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { folder } from '../../test/fixtures'
import { A, B, C, commit, COMMITS, diffOf, file, HOUR, LOG, MAIN, NOW } from '../../test/history'
import { spoken } from '../../test/spoken'
import { now } from '../lib/clock'
import { clock } from '../lib/time'
import { href, route } from '../lib/router'
import { folders, ready, resetStore } from '../lib/store'
import { toasts } from '../lib/toast'
import type { Commit } from '../lib/types'
import { CommitPanel, type GraphRoute } from './Commit'
import { forgetCommits, shownLog } from './useLog'

interface Call {
  url: string
}

type Reply = Response | Promise<Response> | undefined

let calls: Call[] = []
let reply: (c: Call) => Reply = () => undefined

const url = (c: Call) => new URL(c.url, 'http://mori.test')
const reads = (path: string) => calls.filter((c) => url(c).pathname === path).map((c) => Object.fromEntries(url(c).searchParams))
const fail = (status: number, kind: string, message: string) => Response.json({ error: { kind, message } }, { status })
const region = (name: string | RegExp) => screen.getByRole('region', { name })
const toastTexts = () => toasts.value.map((t) => [t.text, t.kind])

function serve(commits: Record<string, Commit> = COMMITS) {
  reply = (c) => {
    const u = url(c)
    if (u.pathname === '/api/git/commit') {
      const found = commits[u.searchParams.get('rev')!]
      return found ? Response.json(found) : fail(404, 'not_found', '그런 커밋이 없습니다')
    }
    if (u.pathname === '/api/git/diff') return Response.json({ diff: diffOf(u.searchParams.get('file')!), truncated: false })
    return undefined
  }
}

const at = (c: string): GraphRoute => ({ name: 'graph', folder: 'f1', head: false, c })

/** The panel as Shell draws it: it follows the address. */
function Routed({ onClose = () => {} }: { onClose?: () => void }) {
  const r = route.value
  return r.name === 'graph' && r.c ? <CommitPanel r={r} onClose={onClose} /> : null
}

function open(c: string, onClose?: () => void) {
  route.value = at(c)
  return render(<Routed onClose={onClose} />)
}

/** What a definition list says, term by term; a term's values are kept apart by |. */
function facts(dl: HTMLElement): [string, string][] {
  const out: [string, string][] = []
  for (const el of dl.children) {
    if (el.tagName === 'DT') out.push([spoken(el), ''])
    else out[out.length - 1][1] += (out[out.length - 1][1] ? ' | ' : '') + spoken(el)
  }
  return out
}

beforeEach(() => {
  calls = []
  reply = () => undefined
  vi.stubGlobal(
    'fetch',
    vi.fn(async (u: string) => {
      const c = { url: String(u) }
      calls.push(c)
      return (await reply(c)) ?? Response.json({})
    }),
  )
  folders.value = [folder()]
  ready.value = true
  now.value = NOW
  toasts.value = []
  shownLog.value = { path: MAIN, byHash: new Map(LOG.commits.map((x) => [x.hash, x])) }
})

afterEach(() => {
  cleanup()
  resetStore()
  forgetCommits()
  shownLog.value = null
  toasts.value = []
  route.value = { name: 'queue' }
  history.replaceState(null, '', '/')
  vi.unstubAllGlobals()
})

describe('CommitPanel', () => {
  it('shows the commit, its names and parents, and the first file’s diff', async () => {
    serve()
    const close = vi.fn()
    open(C, close)
    expect(screen.getByText('ccccccc').getAttribute('title')).toBe(C)
    expect(screen.getByText('불러오는 중')).toBeTruthy()
    expect(await screen.findByRole('heading', { level: 3, name: 'fix/notify 병합' })).toBeTruthy()
    expect(screen.getByText('알림 고침을 가져옵니다.')).toBeTruthy()

    const sum = region('커밋 내용')
    expect(facts(sum.querySelector('dl')!)).toEqual([
      ['작성', `김하늘 · 오늘 ${clock(NOW - 5 * 60_000)} (5분 전)`],
      ['이름표', '현재 브랜치 main 원격 origin/main 태그 v0.2.0'],
      ['부모', 'aaaaaaa 처음 | bbbbbbb 알림이 두 번 뜨던 문제 고침'],
      ['해시', C],
    ])
    expect(within(sum).getByText('김하늘').getAttribute('title')).toBe('sky@example.com')
    expect(within(sum).getByRole('link', { name: 'aaaaaaa' }).getAttribute('href')).toBe(href(at(A)))
    expect(within(sum).getByRole('link', { name: 'bbbbbbb' }).getAttribute('href')).toBe(href(at(B)))

    const files = region('파일 3')
    expect(within(files).getByText('병합 커밋입니다. 첫 부모와 비교합니다.')).toBeTruthy()
    expect(within(files).getByText('3줄 추가, 1줄 삭제', { selector: '.cm-totals .sr-only' })).toBeTruthy()
    const buttons = within(files).getAllByRole('button')
    expect(buttons.map(spoken)).toEqual([
      '수정 notify.go internal/push 3줄 추가, 1줄 삭제',
      '이름 바꿈 new.md docs · docs/old.md에서 옮김 0줄 추가, 0줄 삭제',
      '추가 icon.png web/public 바이너리',
    ])
    expect(buttons[0].textContent).toContain('+3 −1')
    expect(buttons.map((b) => b.getAttribute('aria-current'))).toEqual(['true', null, null])
    await within(region('notify.go 변경 내용')).findByText('-old internal/push/notify.go')
    expect(reads('/api/git/diff')).toEqual([{ path: MAIN, file: 'internal/push/notify.go', rev: C }])

    fireEvent.click(buttons[1])
    expect(buttons.map((b) => b.getAttribute('aria-current'))).toEqual([null, 'true', null])
    await within(region('new.md 변경 내용')).findByText('+new docs/new.md')
    expect(reads('/api/git/diff').at(-1)).toEqual({ path: MAIN, file: 'docs/new.md', orig: 'docs/old.md', rev: C })
    expect(reads('/api/git/commit')).toEqual([{ path: MAIN, rev: C }])

    fireEvent.click(screen.getByRole('button', { name: '커밋 닫기' }))
    expect(close).toHaveBeenCalledOnce()
  })

  it('follows a parent and shows its first file again', async () => {
    serve()
    history.replaceState(null, '', '/' + href(at(C)))
    const before = history.length
    open(C)
    await screen.findByRole('heading', { level: 3, name: 'fix/notify 병합' })
    fireEvent.click(screen.getAllByRole('button')[3])
    fireEvent.click(screen.getByRole('link', { name: 'bbbbbbb' }))
    expect(route.value).toEqual(at(B))
    expect(location.hash).toBe(href(at(B)))
    expect(history.length).toBe(before)
    expect(await screen.findByRole('heading', { level: 3, name: '알림이 두 번 뜨던 문제 고침' })).toBeTruthy()
    expect(within(region('파일 2')).getAllByRole('button')[0].getAttribute('aria-current')).toBe('true')
    // A commit not merged has nothing to say about parents.
    expect(screen.queryByText('병합 커밋입니다. 첫 부모와 비교합니다.')).toBeNull()

    // A commit read before is not read again.
    fireEvent.click(screen.getByRole('link', { name: 'aaaaaaa' }))
    await screen.findByRole('heading', { level: 3, name: '처음' })
    route.value = at(C)
    expect(await screen.findByRole('heading', { level: 3, name: 'fix/notify 병합' })).toBeTruthy()
    expect(reads('/api/git/commit').map((q) => q.rev)).toEqual([C, B, A])
  })

  it('says who committed it when that is someone else, and when there is no parent', async () => {
    const root = commit(A, {
      committer: 'Mori Bot',
      committer_email: 'bot@example.com',
      commit_ms: NOW - 2 * HOUR,
      message: '처음\n',
      files: [],
    })
    serve({ [A]: root })
    shownLog.value = null
    open(A)
    const sum = await screen.findByRole('region', { name: '커밋 내용' })
    expect(facts(sum.querySelector('dl')!)).toEqual([
      ['작성', `김하늘 · 오늘 ${clock(NOW - HOUR)} (1시간 전)`],
      ['커밋', `Mori Bot · 오늘 ${clock(NOW - 2 * HOUR)} (2시간 전)`],
      ['부모', '없음 (처음 커밋)'],
      ['해시', A],
    ])
    expect(within(sum).getByText('Mori Bot').getAttribute('title')).toBe('bot@example.com')
    const files = region('파일 0')
    expect(within(files).getByText('바뀐 파일이 없습니다')).toBeTruthy()
    expect(within(files).queryByRole('button')).toBeNull()
    expect(screen.queryByRole('region', { name: /변경 내용$/ })).toBeNull()
  })

  it('says when there are too many files to list, and counts with commas', async () => {
    serve({ [B]: commit(B, { parents: [A], files: [file('a.go', { added: 3000, deleted: 1200 }), file('b.go')], truncated: true }) })
    open(B)
    const files = await screen.findByRole('region', { name: '파일 2+' })
    expect(within(files).getByText('파일이 너무 많아 앞의 2개만 보입니다')).toBeTruthy()
    const totals = files.querySelector('.cm-totals')!
    expect(totals.textContent).toContain('+3,001 −1,201')
    expect(spoken(totals)).toBe('3,001줄 추가, 1,201줄 삭제')
    expect(spoken(within(files).getAllByRole('button')[0])).toBe('수정 a.go 3,000줄 추가, 1,200줄 삭제')
  })

  it('says why a commit could not be read', async () => {
    serve({})
    open(B)
    expect((await screen.findByRole('alert')).textContent).toBe('그런 커밋이 없습니다')
  })

  it('copies the whole hash, also where the clipboard API is not', async () => {
    serve()
    let copied = ''
    const exec = vi.fn(() => {
      copied = (document.activeElement as HTMLTextAreaElement).value
      return true
    })
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true })
    try {
      open(C)
      const copy = screen.getByRole('button', { name: '전체 해시 복사' })
      copy.focus()
      fireEvent.click(copy)
      await vi.waitFor(() => expect(toastTexts()).toEqual([['해시를 복사했습니다', 'info']]))
      expect(exec).toHaveBeenCalledWith('copy')
      expect(copied).toBe(C)
      // The focus comes back to the button, and the text box goes.
      expect(document.activeElement).toBe(copy)
      expect(document.querySelector('textarea')).toBeNull()

      exec.mockReturnValue(false)
      fireEvent.click(copy)
      await vi.waitFor(() => expect(toastTexts().at(-1)).toEqual(['복사하지 못했습니다', 'error']))
    } finally {
      delete (document as Partial<Document>).execCommand
    }
  })
})
