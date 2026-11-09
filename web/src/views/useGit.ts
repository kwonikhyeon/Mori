// What the Git panel and screen read: the folder's worktrees from the
// store, and one worktree's changes and a file's diff from the server.
// Both are read again every 10 seconds while the page is seen, when the
// window gets the focus, when the session's status moves and on 새로 고침;
// never twice within two seconds unless asked (spec §3 #137).
//
// The reads run in layout effects: a read asked for by a timer starts as
// the page renders, not a frame later.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { api, ApiError } from '../lib/api'
import { parseDiff, type DiffFile } from '../lib/diff'
import { homeWorktree, type ChangeItem } from '../lib/format'
import { folders, ready } from '../lib/store'
import { errorText } from '../lib/toast'
import type { Diff, FolderView, GitStatus, Worktree } from '../lib/types'
import { onWake } from '../lib/wake'

const GAP = 2_000
const EVERY = 10_000

/** A read that could not reach the server keeps what it read before. */
const offline = (e: unknown) => e instanceof ApiError && e.status === 0

interface Ticker {
  /** Notes that a read starts now. */
  mark: () => void
  /** Reads again now. */
  bump: () => void
  /** Reads again, but not within GAP of the last read. */
  soon: () => void
  stop: () => void
}

function useTicker(pulse: number | null | undefined): [number, Ticker] {
  const [tick, setTick] = useState(0)
  const [t] = useState<Ticker>(() => {
    let last = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = () => {
      clearTimeout(timer)
      timer = undefined
    }
    const bump = () => {
      stop()
      setTick((n) => n + 1)
    }
    const soon = () => {
      if (timer !== undefined) return
      const wait = last + GAP - Date.now()
      if (wait <= 0) bump()
      else timer = setTimeout(bump, wait)
    }
    return { mark: () => (last = Date.now()), bump, soon, stop }
  })
  useEffect(() => {
    const every = setInterval(() => document.visibilityState === 'visible' && t.soon(), EVERY)
    const off = onWake(t.soon)
    window.addEventListener('focus', t.soon)
    return () => {
      clearInterval(every)
      off()
      window.removeEventListener('focus', t.soon)
      t.stop()
    }
  }, [t])
  // The session's status moved: what it did may have changed the files.
  const seen = useRef(pulse)
  useEffect(() => {
    if (seen.current === pulse) return
    seen.current = pulse
    t.soon()
  }, [pulse, t])
  return [tick, t]
}

export type GitState = 'loading' | 'missing' | 'norepo' | 'ok'

export interface StatusRead {
  data?: GitStatus
  error?: string
}

export interface GitData {
  state: GitState
  f: FolderView | undefined
  /** The folder's worktrees but a bare one, with one just made. */
  ws: Worktree[]
  /** The worktree shown: the one asked for while it is there, else the folder's own. */
  shown: string
  /** null until the worktree shown is first read. */
  status: StatusRead | null
  tick: number
  refresh: () => void
  /** Shows a worktree just made before the folder list has it. */
  add: (w: Worktree) => void
  /** Forgets a worktree just removed. */
  drop: (path: string) => void
}

export function useGit(fid: string, want: string | undefined, pulse?: number | null): GitData {
  const [tick, t] = useTicker(pulse)
  const [made, setMade] = useState<Worktree | null>(null)
  const f = folders.value.find((x) => x.id === fid)
  const state: GitState = !ready.value ? 'loading' : !f ? 'missing' : !f.repo ? 'norepo' : 'ok'

  const ws = state === 'ok' && f ? f.worktrees.filter((w) => !w.bare) : []
  const known = !!made && ws.some((w) => w.path === made.path)
  if (made && !known && state === 'ok') ws.push(made)
  // Before the server has listed the worktrees, the folder is the one it has.
  const shown = state !== 'ok' || !f ? '' : (ws.find((w) => w.path === want && !w.prunable) ?? homeWorktree(f, ws))?.path ?? (ws.length ? '' : f.path)

  // Once the folder list has it, the list's own entry is the one to show.
  useLayoutEffect(() => {
    if (known) setMade(null)
  }, [known])

  const [st, setSt] = useState<{ path: string } & StatusRead>({ path: '' })
  useLayoutEffect(() => {
    if (!shown) return
    let live = true
    t.mark()
    api.git.status(shown).then(
      (data) => {
        if (live) setSt({ path: shown, data })
      },
      (e) => {
        if (live) setSt((old) => (offline(e) && old.path === shown && old.data ? old : { path: shown, error: errorText(e, '변경을 읽지 못했습니다') }))
      },
    )
    return () => {
      live = false
    }
  }, [shown, tick, t])

  // The server lists the worktrees again as it answers, and tells every
  // page through the event stream when they changed.
  useLayoutEffect(() => {
    if (state === 'ok') api.folders.git(fid).catch(() => {})
  }, [fid, tick, state])

  return {
    state,
    f,
    ws,
    shown,
    status: st.path === shown && (st.data || st.error) ? st : null,
    tick,
    refresh: t.bump,
    add: setMade,
    drop: (path) => setMade((m) => (m?.path === path ? null : m)),
  }
}

export interface DiffRead {
  loading: boolean
  diff?: Diff
  error?: string
  files: DiffFile[]
}

/** The diff of a change in the worktree shown; the one before stays while it is read again. */
export function useDiff(shown: string, item: ChangeItem | undefined, tick: number): DiffRead {
  const key = item ? shown + '\n' + JSON.stringify(item.diff) : ''
  const [d, setD] = useState<{ key: string; diff?: Diff; error?: string }>({ key: '' })
  useLayoutEffect(() => {
    if (!item) return
    let live = true
    api.git.diff(shown, item.diff).then(
      (diff) => {
        if (live) setD({ key, diff })
      },
      (e) => {
        if (live) setD((old) => (offline(e) && old.key === key && old.diff ? old : { key, error: errorText(e, '변경 내용을 읽지 못했습니다') }))
      },
    )
    return () => {
      live = false
    }
    // The key says all of the item and the worktree that the read uses.
  }, [key, tick])
  const cur = d.key === key ? d : null
  const text = cur?.diff?.diff
  const files = useMemo(() => (text === undefined ? [] : parseDiff(text)), [text])
  return { loading: !!key && !cur, diff: cur?.diff, error: cur?.error, files }
}
