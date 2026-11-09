// The shapes the Mori API sends (spec §7). Field names follow the JSON.

export type StatusState = 'idle' | 'working' | 'done' | 'blocked' | 'error'

/** What a program reports about itself. */
export interface Status {
  state: StatusState | string
  app: string
  kind: string | null
  msg: string
  progress: number | null
  title: string
}

export interface Foreground {
  pid: number
  name: string
  argv: string[]
  cwd: string
}

export interface FirstMessage {
  sent: boolean
  reason: string | null
  started: boolean | null
  turn: number | null
}

/** A terminal as the core reports it, plus where Mori files it. */
export interface TerminalView {
  address: string
  argv: string[]
  cols: number
  rows: number
  created_ms: number
  cwd: string
  labels: Record<string, string>
  screen: string
  state: 'live' | 'finished' | string
  die_with_parent: boolean
  identity: string
  keep: boolean
  notify: boolean
  records?: Record<string, Status> | null
  reported: boolean
  rm: boolean
  title: string
  turn: number
  exit_code: number | null
  finished_ms: number | null
  first_message: FirstMessage | null
  foreground: Foreground | null
  name: string | null
  parent: string | null
  paste_gap_ms: number | null
  pid: number | null
  reason: string | null
  signal: number | null
  status: Status | null
  status_ms: number | null
  stop: string | null
  submit: string | null
  template: string | null
  folder_id: string
  worktree: string
  display_title: string
  preset?: string
}

export interface Worktree {
  path: string
  head: string
  branch: string
  main: boolean
  bare: boolean
  detached: boolean
  locked: boolean
  prunable: boolean
}

export interface FolderView {
  id: string
  name: string
  path: string
  created_ms: number
  repo: boolean
  worktrees: Worktree[]
}

export interface CoreStatus {
  connected: boolean
  version?: string
  name?: string
  error?: string
}

export interface Preset {
  id: string
  name: string
  argv: string[]
  task: boolean
}

export interface Host {
  name: string
  url: string
}

export interface Hello {
  app: string
  version: string
  host: string
  paired: boolean
}

export interface Overview {
  host: { name: string; version: string }
  core: CoreStatus
  folders: FolderView[]
  terminals: TerminalView[]
  presets: Preset[]
  hosts: Host[]
}

export interface Device {
  id: string
  name: string
  user_agent: string
  created_ms: number
  last_seen_ms: number
  current: boolean
}

export interface PairCode {
  code: string
  url: string
  expires_ms: number
}

export interface FsEntry {
  name: string
  path: string
  git: boolean
}

export interface FsListing {
  path: string
  parent: string
  entries: FsEntry[]
  truncated: boolean
}

export interface GitSummary {
  repo: boolean
  head: string
  branch: string
  detached: boolean
  upstream: string
  ahead: number
  behind: number
  changes: number
  worktrees: Worktree[]
}

export interface Branch {
  name: string
  head: string
  upstream?: string
  current: boolean
  remote: boolean
}

export interface Branches {
  local: Branch[]
  remote: Branch[]
}

export interface Change {
  path: string
  orig?: string
  index: string
  worktree: string
  kind: 'changed' | 'renamed' | 'unmerged' | 'untracked' | string
}

export interface GitStatus {
  head: string
  branch: string
  detached: boolean
  upstream: string
  ahead: number
  behind: number
  changes: Change[]
}

export interface Diff {
  diff: string
  truncated: boolean
}

export interface Ref {
  name: string
  kind: 'head' | 'branch' | 'remote' | 'tag' | string
  current: boolean
}

export interface Edge {
  lane: number
  color: number
}

export interface LogCommit {
  hash: string
  parents: string[]
  author: string
  time_ms: number
  subject: string
  refs: Ref[]
  lane: number
  color: number
  up: Edge[]
  pass: Edge[]
  down: Edge[]
}

export interface Graph {
  commits: LogCommit[]
  width: number
  more: boolean
}

export interface CommitFile {
  path: string
  orig?: string
  kind: 'added' | 'deleted' | 'modified' | 'renamed' | 'copied' | 'typechange' | string
  added: number
  deleted: number
  binary: boolean
}

export interface Commit {
  hash: string
  parents: string[]
  author: string
  email: string
  author_ms: number
  committer: string
  committer_email: string
  commit_ms: number
  message: string
  files: CommitFile[]
  truncated: boolean
}

export interface SendResult {
  started?: boolean
  status?: string
  turn?: number
  wait?: unknown
}

export interface Upload {
  path: string
  bytes: number
}

export interface ScreenText {
  text: string
  complete: boolean
  how: string
}

export type PushKind = 'blocked' | 'waiting' | 'error' | 'exited'

export interface PushSubscriptionView {
  id: string
  endpoint: string
  kinds: PushKind[]
  created_ms: number
}

export interface PushSettings {
  children: boolean
}

/** The messages of /ws/events (spec §7.2). */
export type EventMessage =
  | { type: 'snapshot'; core: CoreStatus; folders: FolderView[]; terminals: TerminalView[] }
  | { type: 'terminal'; terminal: TerminalView }
  | { type: 'removed'; address: string }
  | { type: 'folders'; folders: FolderView[] }
  | ({ type: 'core' } & CoreStatus)
  | { type: 'ping' }

/** The JSON messages of /ws/attach from the server (spec §7.3). */
export type AttachMessage =
  | { type: 'attached'; terminal: TerminalView; cols: number; rows: number }
  | { type: 'size'; cols: number; rows: number }
  | { type: 'closed'; reason: string; exit_code: number | null; signal: number | null }
