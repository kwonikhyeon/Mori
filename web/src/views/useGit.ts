// What the Git panel and screen read: the folder's worktrees from the
// host's store, and one worktree's changes and a file's diff from the host.
// Both are read again every 10 seconds while the page is seen, when the
// window gets the focus, when the session's status moves and on 새로 고침;
// never twice within two seconds unless asked (spec §3 #137).
//
// The reads run in layout effects: a read asked for by a timer starts as
// the page renders, not a frame later.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { ApiError } from '../lib/api'
import { parseDiff, type DiffFile } from '../lib/diff'
import { homeWorktree, type ChangeItem } from '../lib/format'
import { useHost } from '../lib/scope'
import { errorText } from '../lib/toast'
import type { Diff, FolderView, GitStatus, Worktree } from '../lib/types'
import { onWake } from '../lib/wake'

const GAP = 2_000
const EVERY = 10_000

/** A read that could not reach the server keeps what it read before. */
export const offline = (e: unknown) => e instanceof ApiError && e.status === 0

interface Ticker {
  /** Notes that a read starts now. */
  mark: () => void
  /** Reads again now. */
  bump: () => void
  /** Reads again, but not within GAP of the last read. */
  soon: () => void
  stop: () => void
}

/** When to read again: every `every` ms while the page is seen (0: never by itself), on the focus, on waking and when `pulse` moves. */
export function useTicker(pulse: number | null | undefined, every = EVERY): [number, Ticker] {
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
    const timer = every > 0 ? setInterval(() => document.visibilityState === 'visible' && t.soon(), every) : undefined
    const off = onWake(t.soon)
    window.addEventListener('focus', t.soon)
    return () => {
      clearInterval(timer)
      off()
      window.removeEventListener('focus', t.soon)
      t.stop()
    }
  }, [t, every])
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

/** Whether a folder's Git can be read: not before the host's folders are (ready), nor of one not there or not a repository. */
export function gitState(f: FolderView | undefined, ready: boolean): GitState {
  return !ready ? 'loading' : !f ? 'missing' : !f.repo ? 'norepo' : 'ok'
}

/** The worktree to show: the one asked for while it is there, else the folder's own; before the server has listed them, the folder. */
export function pickShown(f: FolderView, ws: Worktree[], want: string | undefined): string {
  return (ws.find((w) => w.path === want && !w.prunable) ?? homeWorktree(f, ws))?.path ?? (ws.length ? '' : f.path)
}

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
  const h = useHost()
  const [tick, t] = useTicker(pulse)
  const [made, setMade] = useState<Worktree | null>(null)
  const f = h.folders.value.find((x) => x.id === fid)
  const state = gitState(f, h.ready.value)

  const ws = state === 'ok' && f ? f.worktrees.filter((w) => !w.bare) : []
  const known = !!made && ws.some((w) => w.path === made.path)
  if (made && !known && state === 'ok') ws.push(made)
  const shown = state !== 'ok' || !f ? '' : pickShown(f, ws, want)

  // Once the folder list has it, the list's own entry is the one to show.
  useLayoutEffect(() => {
    if (known) setMade(null)
  }, [known])

  const [st, setSt] = useState<{ path: string } & StatusRead>({ path: '' })
  useLayoutEffect(() => {
    if (!shown) return
    let live = true
    t.mark()
    h.api.git.status(shown).then(
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
  }, [shown, tick, t, h])

  // The server lists the worktrees again as it answers, and tells every
  // page through the event stream when they changed.
  useLayoutEffect(() => {
    if (state === 'ok') h.api.folders.git(fid).catch(() => {})
  }, [fid, tick, state, h])

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
  const h = useHost()
  const key = item ? h.id + '\n' + shown + '\n' + JSON.stringify(item.diff) : ''
  const [d, setD] = useState<{ key: string; diff?: Diff; error?: string }>({ key: '' })
  useLayoutEffect(() => {
    if (!item) return
    let live = true
    h.api.git.diff(shown, item.diff).then(
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
    // The key says the host, all of the item and the worktree that the read uses.
  }, [key, tick])
  const cur = d.key === key ? d : null
  const text = cur?.diff?.diff
  const files = useMemo(() => (text === undefined ? [] : parseDiff(text)), [text])
  return { loading: !!key && !cur, diff: cur?.diff, error: cur?.error, files }
}
