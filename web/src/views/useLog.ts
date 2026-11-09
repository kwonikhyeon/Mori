// What the graph screen reads: a worktree's log, read again on 새로 고침,
// on the focus and on waking, but not on a timer, since a log costs more
// than a status (spec §3 #107, #137); and a commit, which never changes, so
// those read stay remembered.
import { signal } from '@preact/signals'
import { useLayoutEffect, useState } from 'preact/hooks'
import { api } from '../lib/api'
import { folders } from '../lib/store'
import { errorText } from '../lib/toast'
import type { Commit, FolderView, Graph, LogCommit } from '../lib/types'
import { gitState, offline, pickShown, useTicker, type GitState } from './useGit'

/** The commits a read asks for at first, and what 더 불러오기 adds. */
export const LOG_STEP = 200
/** The most the server gives; older ones are for the terminal. */
export const LOG_MAX = 2000

/** The log the graph screen shows, for the commit beside it: its names and its parents' subjects. */
export const shownLog = signal<{ path: string; byHash: Map<string, LogCommit> } | null>(null)

/** The screen a PC opened a folder's graph from, for the way back. */
export const graphFrom = signal<{ folder: string; href: string } | null>(null)

export interface Repo {
  state: GitState
  f: FolderView | undefined
  /** The worktree whose HEAD the graph marks; "" when none can be opened. */
  shown: string
}

export function useRepo(fid: string, want: string | undefined): Repo {
  const f = folders.value.find((x) => x.id === fid)
  const state = gitState(f)
  const shown = state === 'ok' && f ? pickShown(f, f.worktrees.filter((w) => !w.bare), want) : ''
  return { state, f, shown }
}

export interface LogData {
  data?: Graph
  error?: string
  /** A longer log is on its way. */
  pending: boolean
  /** Reads LOG_STEP more, up to LOG_MAX (spec §3 #128). */
  more: () => void
  refresh: () => void
}

/** The log of one worktree: of all branches, or what HEAD reaches. The last one read stays while it is read again or longer. */
export function useLog(path: string, head: boolean): LogData {
  const [tick, t] = useTicker(undefined, 0)
  const [limit, setLimit] = useState(LOG_STEP)
  const key = path + '\n' + (head ? 'head' : 'all')
  const [st, setSt] = useState<{ key: string; limit: number; data?: Graph; error?: string }>({ key: '', limit: 0 })
  useLayoutEffect(() => {
    if (!path) return
    let live = true
    t.mark()
    api.git.log(path, { limit, head }).then(
      (data) => {
        if (live) setSt({ key, limit, data })
      },
      (e) => {
        if (!live) return
        // The list read before stays; offline, the banner says why it is old.
        const error = errorText(e, '커밋 기록을 읽지 못했습니다')
        setSt((old) => (old.key === key && old.data ? { ...old, limit, error: offline(e) ? undefined : error } : { key, limit, error }))
      },
    )
    return () => {
      live = false
    }
    // The key says the path and the scope the read uses.
  }, [key, limit, tick, t])
  const cur = st.key === key ? st : null
  return {
    data: cur?.data,
    error: cur?.error,
    pending: !!cur && cur.limit !== limit,
    more: () => {
      // After a longer read that failed, the same length again.
      const next = Math.min(LOG_MAX, (cur?.data?.commits.length ?? 0) + LOG_STEP)
      if (next === limit) t.bump()
      else setLimit(next)
    },
    refresh: t.bump,
  }
}

const KEEP = 100
const commits = new Map<string, Commit>()

/** Forgets the commits read; for tests. */
export function forgetCommits() {
  commits.clear()
}

export interface CommitRead {
  data?: Commit
  error?: string
}

export function useCommit(path: string, rev: string): CommitRead {
  const key = path && rev ? path + '\n' + rev : ''
  const [st, setSt] = useState<{ key: string } & CommitRead>({ key: '' })
  useLayoutEffect(() => {
    if (!key || commits.has(key)) return
    let live = true
    api.git.commit(path, rev).then(
      (data) => {
        commits.set(key, data)
        if (commits.size > KEEP) commits.delete(commits.keys().next().value!)
        if (live) setSt({ key, data })
      },
      (e) => {
        if (live) setSt({ key, error: errorText(e, '커밋을 읽지 못했습니다') })
      },
    )
    return () => {
      live = false
    }
  }, [key])
  const known = key ? commits.get(key) : undefined
  if (known) return { data: known }
  return st.key === key ? st : {}
}
