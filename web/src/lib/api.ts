// The REST API of the Mori server (spec §7.1). Every call is a same-origin
// fetch with the device cookie; an error comes back as an ApiError that
// carries the server's message for the screen.

import type {
  Branches, Commit, Device, Diff, FolderView, FsListing, GitStatus, GitSummary, Graph, Hello, Host,
  Overview, PairCode, Preset, PushKind, PushSettings, PushSubscriptionView, ScreenText, SendResult,
  TerminalView, Upload, Worktree,
} from './types'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly kind: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

let unauthorized: (() => void) | null = null

/** Sets what runs when the server says this device is not paired. */
export function onUnauthorized(fn: (() => void) | null): void {
  unauthorized = fn
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin' }
  if (body instanceof FormData) {
    init.body = body
  } else if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  let res: Response
  try {
    res = await fetch(path, init)
  } catch {
    throw new ApiError(0, 'network', '서버에 연결할 수 없습니다')
  }
  if (res.status === 204) return undefined as T
  const text = await res.text()
  let data: unknown
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    data = undefined
  }
  if (!res.ok) {
    const e = (data as { error?: { kind?: string; message?: string; hint?: string } } | undefined)?.error
    const err = e?.kind && e.message
      ? new ApiError(res.status, e.kind, e.message, e.hint)
      : new ApiError(res.status, 'http', `요청이 실패했습니다 (${res.status})`)
    if (res.status === 401 && err.kind === 'unauthorized') unauthorized?.()
    throw err
  }
  return data as T
}

type QueryValue = string | number | boolean | null | undefined

/** A query string without the empty values; true is written as 1. */
export function query(params: Record<string, QueryValue>): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === false) continue
    q.set(k, v === true ? '1' : String(v))
  }
  const s = q.toString()
  return s ? '?' + s : ''
}

const seg = encodeURIComponent

/** The REST path of a terminal; machine/t7 stays one segment. */
export function termPath(addr: string): string {
  return '/api/terminals/' + seg(addr)
}

/** The WebSocket address of path on this host. */
export function wsURL(path: string, loc: Pick<Location, 'protocol' | 'host'> = location): string {
  return (loc.protocol === 'https:' ? 'wss://' : 'ws://') + loc.host + path
}

export interface CreateTerminal {
  folder_id: string
  preset: string
  worktree?: string
  task?: string
  title?: string
  cols?: number
  rows?: number
}

export interface NewWorktree {
  branch: string
  create: boolean
  base?: string
}

export interface DiffQuery {
  file?: string
  staged?: boolean
  rev?: string
  orig?: string
}

const get = <T>(path: string) => request<T>('GET', path)

export const api = {
  hello: () => get<Hello>('/api/hello'),
  pair: (code: string, name: string) => request<void>('POST', '/api/pair', { code, name }),
  logout: () => request<void>('POST', '/api/logout'),
  overview: () => get<Overview>('/api/overview'),

  devices: () => get<Device[]>('/api/devices'),
  revokeDevice: (id: string) => request<void>('DELETE', '/api/devices/' + seg(id)),
  pairCode: (name: string) => request<PairCode>('POST', '/api/pair-codes', { name }),

  folders: {
    list: () => get<FolderView[]>('/api/folders'),
    add: (path: string, name = '') => request<FolderView>('POST', '/api/folders', { path, name }),
    rename: (id: string, name: string) => request<FolderView>('PATCH', '/api/folders/' + seg(id), { name }),
    remove: (id: string) => request<void>('DELETE', '/api/folders/' + seg(id)),
    git: (id: string) => get<GitSummary>(`/api/folders/${seg(id)}/git`),
    branches: (id: string) => get<Branches>(`/api/folders/${seg(id)}/branches`),
    addWorktree: (id: string, w: NewWorktree) => request<Worktree>('POST', `/api/folders/${seg(id)}/worktrees`, w),
    removeWorktree: (id: string, path: string, force: boolean) =>
      request<void>('DELETE', `/api/folders/${seg(id)}/worktrees` + query({ path, force })),
  },

  fs: (path = '', hidden = false) => get<FsListing>('/api/fs' + query({ path, hidden })),

  git: {
    status: (path: string) => get<GitStatus>('/api/git/status' + query({ path })),
    diff: (path: string, d: DiffQuery = {}) => get<Diff>('/api/git/diff' + query({ path, ...d })),
    log: (path: string, o: { limit?: number; head?: boolean } = {}) =>
      get<Graph>('/api/git/log' + query({ path, limit: o.limit, head: o.head })),
    commit: (path: string, rev: string) => get<Commit>('/api/git/commit' + query({ path, rev })),
  },

  terminals: {
    list: (all = false) => get<TerminalView[]>('/api/terminals' + query({ all })),
    create: (req: CreateTerminal) => request<TerminalView>('POST', '/api/terminals', req),
    get: (addr: string) => get<TerminalView>(termPath(addr)),
    rename: (addr: string, title: string) => request<TerminalView>('PATCH', termPath(addr), { title }),
    remove: (addr: string) => request<void>('DELETE', termPath(addr)),
    send: (addr: string, text: string, force = false) =>
      request<SendResult>('POST', termPath(addr) + '/send', force ? { text, force } : { text }),
    keys: (addr: string, keys: string[]) => request<unknown>('POST', termPath(addr) + '/keys', { keys }),
    interrupt: (addr: string) => request<unknown>('POST', termPath(addr) + '/interrupt', {}),
    kill: (addr: string) => request<TerminalView>('POST', termPath(addr) + '/kill'),
    upload: (addr: string, file: File) => {
      const form = new FormData()
      form.append('file', file, file.name)
      return request<Upload>('POST', termPath(addr) + '/files', form)
    },
    text: (addr: string, lines?: number) => get<ScreenText>(termPath(addr) + '/text' + query({ lines })),
  },

  presets: {
    get: () => get<Preset[]>('/api/presets'),
    put: (ps: Preset[]) => request<Preset[]>('PUT', '/api/presets', ps),
  },
  hosts: {
    get: () => get<Host[]>('/api/hosts'),
  },

  push: {
    key: () => get<{ key: string }>('/api/push/key'),
    list: () => get<PushSubscriptionView[]>('/api/push/subscriptions'),
    subscribe: (subscription: PushSubscriptionJSON, kinds: PushKind[]) =>
      request<PushSubscriptionView>('POST', '/api/push/subscriptions', { subscription, kinds }),
    unsubscribe: (endpoint: string) => request<void>('DELETE', '/api/push/subscriptions', { endpoint }),
    test: () => request<{ sent: number }>('POST', '/api/push/test'),
    settings: () => get<PushSettings>('/api/push/settings'),
    putSettings: (s: PushSettings) => request<PushSettings>('PUT', '/api/push/settings', s),
  },
}
