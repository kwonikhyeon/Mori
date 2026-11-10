// Git for a folder: the branch of the worktree shown, the folder's
// worktrees, and the changes with a file's diff. Beside a session on a PC
// (the B-PC board's aside), as a screen of its own from the folders and on
// a phone (the B-Git board). It only reads; commits and pushes are for the
// terminal.
import { signal } from '@preact/signals'
import { useMemo, useState } from 'preact/hooks'
import { ConnBanner } from '../components/ConnBanner'
import { Icon } from '../components/Icon'
import { totals } from '../lib/diff'
import { branchLine, changeGroups, fileParts, shortPath, wtLabel, type ChangeGroup, type ChangeItem } from '../lib/format'
import { useHost, type HostScope } from '../lib/scope'
import { DiffView } from './Diff'
import { ChangeCards, ChangeList } from './GitChanges'
import { WorktreeList } from './GitWorktrees'
import { Loading, type Variant } from './rows'
import { useDiff, useGit, type GitData } from './useGit'
import { graphFrom } from './useLog'
import './git.css'

/** The session a phone opened Git from: back goes to it, and its worktree is marked. */
export const gitFrom = signal('')

/** The changes in groups, and the one a PC shows: the one picked while it is there, else the first; none until they are read. */
function useChanges(g: GitData) {
  const [sel, setSel] = useState<string>()
  const data = g.status?.data
  const groups = useMemo(() => changeGroups(data?.changes ?? []), [data])
  const items = groups.flatMap((x) => x.items)
  const item = items.find((x) => x.key === sel) ?? items[0]
  return { groups, item, setSel }
}

function Refresh({ g, size = 16 }: { g: GitData; size?: number }) {
  return (
    <button type="button" class="btn btn-icon btn-ghost gp-refresh" aria-label="새로 고침" title="새로 고침" disabled={g.state !== 'ok'} onClick={g.refresh}>
      <Icon name="refresh" size={size} />
    </button>
  )
}

/** Why there is nothing to show: still loading, or no repository there. */
function StateNote({ g }: { g: GitData }) {
  if (g.state === 'loading') return <Loading />
  return (
    <div class="empty gp-empty">
      <span class="empty-icon">
        <Icon name="git" size={24} />
      </span>
      <p class="empty-title">{g.state === 'missing' ? '폴더를 찾을 수 없습니다' : '이 폴더는 git 저장소가 아닙니다'}</p>
    </div>
  )
}

/** The branch line from the status, or the worktree's own until it is read. */
function useBranch(g: GitData) {
  const s = g.status?.data
  const w = g.ws.find((x) => x.path === g.shown)
  return { s, line: s ? branchLine(s) : { name: w ? wtLabel(w) : '', sub: '' } }
}

function AheadBehind({ g }: { g: GitData }) {
  const s = g.status?.data
  if (!s?.upstream) return null
  return (
    <span class="mono gp-ab" aria-hidden="true" title={s.upstream}>
      ↑{s.ahead} ↓{s.behind}
    </span>
  )
}

const graphHref = (h: HostScope, g: GitData) => h.href({ name: 'graph', folder: g.f!.id, path: g.shown, head: false })

/** The graph's way back is the screen it was opened from. */
const fromHere = (h: HostScope, g: GitData) => () => {
  graphFrom.value = { host: h.id, folder: g.f!.id, href: location.hash }
}

function BranchRow({ g }: { g: GitData }) {
  const h = useHost()
  const { line } = useBranch(g)
  return (
    <section class="gp-branch" aria-label="브랜치">
      <div class="gp-branch-main">
        <div class="gp-branch-line">
          <span class="mono gp-branch-name">{line.name}</span>
          <AheadBehind g={g} />
        </div>
        <span class="gp-branch-sub">{line.sub ? line.sub + ' · 보기만 합니다' : '보기만 합니다'}</span>
      </div>
      {g.shown && (
        <a class="btn btn-sm gp-graph" href={graphHref(h, g)} onClick={fromHere(h, g)}>
          <Icon name="graph" size={15} />
          그래프
        </a>
      )}
    </section>
  )
}

function BranchCard({ g }: { g: GitData }) {
  const { line } = useBranch(g)
  return (
    <section class="gs-card gs-branch" aria-label="브랜치">
      <div class="gs-branch-line">
        <span class="mono gs-branch-name">{line.name}</span>
        <AheadBehind g={g} />
      </div>
      {line.sub && <span class="gs-branch-sub">{line.sub}</span>}
      <p class="gs-note">
        <Icon name="eye" size={16} />
        보기만 합니다. 커밋과 푸시는 터미널에서 하세요.
      </p>
    </section>
  )
}

/** The diff of the change picked on a PC, or of a commit's file. */
export function DiffPane({ shown, item, tick }: { shown: string; item: ChangeItem; tick: number }) {
  const d = useDiff(shown, item, tick)
  const t = totals(d.files)
  const orig = item.diff.orig
  return (
    <section class="gp-diff" aria-label={`${fileParts(item.path).name} 변경 내용`}>
      <div class="gp-diff-head mono">
        <span class="gp-diff-path" title={item.path}>
          {orig ? `${orig} → ${item.path}` : item.path}
        </span>
        {d.diff && (
          <>
            <span class="gp-diff-counts" aria-hidden="true">
              <span class="add">+{t.added.toLocaleString('ko-KR')}</span> <span class="del">−{t.deleted.toLocaleString('ko-KR')}</span>
            </span>
            <span class="sr-only">
              {t.added.toLocaleString('ko-KR')}줄 추가, {t.deleted.toLocaleString('ko-KR')}줄 삭제
            </span>
          </>
        )}
      </div>
      <div class="gp-diff-body" tabIndex={0}>
        {d.error ? (
          <p class="gp-error" role="alert">
            {d.error}
          </p>
        ) : d.diff ? (
          <DiffView key={item.key} files={d.files} truncated={d.diff.truncated} wrap />
        ) : (
          <Loading />
        )}
      </div>
    </section>
  )
}

/** The changes listed on a PC, or why they are not. */
function PcChanges({ g, groups, item, onSel }: { g: GitData; groups: ChangeGroup[]; item?: ChangeItem; onSel: (key: string) => void }) {
  if (!g.shown) return <p class="qnote">열 수 있는 워크트리가 없습니다</p>
  if (!g.status) return <Loading />
  if (g.status.error)
    return (
      <p class="gp-error" role="alert">
        {g.status.error}
      </p>
    )
  return <ChangeList groups={groups} count={g.status.data!.changes.length} sel={item?.key} onSel={onSel} />
}

function PhoneChanges({ g, groups }: { g: GitData; groups: ChangeGroup[] }) {
  if (!g.shown) return <p class="qnote">열 수 있는 워크트리가 없습니다</p>
  if (!g.status) return <Loading />
  if (g.status.error)
    return (
      <p class="gp-error" role="alert">
        {g.status.error}
      </p>
    )
  return <ChangeCards groups={groups} count={g.status.data!.changes.length} shown={g.shown} tick={g.tick} />
}

export interface GitPanelProps {
  folder: string
  /** The session's worktree: shown first and marked 이 세션. */
  path?: string
  /** When the session's status last moved: the changes are read again. */
  pulse?: number | null
  onClose: () => void
}

/** Beside a session on a PC; picking another worktree shows it here and leaves the address. */
export function GitPanel({ folder, path, pulse, onClose }: GitPanelProps) {
  const [pick, setPick] = useState<string>()
  const g = useGit(folder, pick ?? path, pulse)
  const { groups, item, setSel } = useChanges(g)
  return (
    <div class="gp">
      <header class="gp-head">
        <Icon name="git" size={16} class="gp-head-icon" />
        <h2 class="gp-title">Git</h2>
        {g.f && <span class="gp-folder">{g.f.name}</span>}
        <Refresh g={g} />
        <button type="button" class="btn btn-icon btn-ghost gp-close" aria-label="Git 닫기" title="Git 닫기" onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
      </header>
      {g.state !== 'ok' ? (
        <StateNote g={g} />
      ) : (
        <>
          <div class={'gp-top' + (item ? ' has-diff' : '')}>
            <BranchRow g={g} />
            <WorktreeList
              variant="pc"
              g={g}
              own={path}
              onShow={setPick}
              onMade={(w) => {
                g.add(w)
                setPick(w.path)
                g.refresh()
              }}
              onRemoved={(p) => {
                g.drop(p)
                if (g.shown === p) setPick(undefined)
                g.refresh()
              }}
            />
            <PcChanges g={g} groups={groups} item={item} onSel={setSel} />
          </div>
          {item && <DiffPane shown={g.shown} item={item} tick={g.tick} />}
        </>
      )}
    </div>
  )
}

export interface GitScreenProps {
  variant: Variant
  folder: string
  /** The worktree to show; the folder's own when it is not one of them. */
  path?: string
  /** Where 뒤로 goes on a phone; the host's folders unless given. */
  back?: string
}

/** A screen of its own: the worktree shown is in the address. */
export function GitScreen({ variant, folder, path, back }: GitScreenProps) {
  const h = useHost()
  const from = variant === 'phone' && gitFrom.value ? h.terminals.value.get(gitFrom.value) : undefined
  const g = useGit(folder, path, from?.status_ms)
  const { groups, item, setSel } = useChanges(g)
  const show = (p: string) => h.go({ name: 'git', folder, path: p }, { replace: true })
  const sub = g.f ? g.f.name + (g.shown ? ' · ' + shortPath(g.shown) : '') : ''
  const list = (
    <WorktreeList
      variant={variant}
      g={g}
      own={from?.folder_id === folder ? from.worktree || undefined : undefined}
      onShow={show}
      onMade={(w) => {
        g.add(w)
        show(w.path)
        g.refresh()
      }}
      onRemoved={(p) => {
        g.drop(p)
        if (g.shown === p) h.go({ name: 'git', folder }, { replace: true })
        g.refresh()
      }}
    />
  )

  if (variant === 'pc') {
    return (
      <div class="gs gs-pc">
        <header class="gs-head">
          <div class="gs-titles">
            <h1>Git</h1>
            {sub && <p class="gs-sub">{sub}</p>}
          </div>
          <Refresh g={g} />
        </header>
        {g.state !== 'ok' ? (
          <StateNote g={g} />
        ) : (
          <div class="gs-cols">
            <div class="gs-list">
              <BranchRow g={g} />
              {list}
              <PcChanges g={g} groups={groups} item={item} onSel={setSel} />
            </div>
            {item ? <DiffPane shown={g.shown} item={item} tick={g.tick} /> : <div class="gs-nodiff" />}
          </div>
        )}
      </div>
    )
  }

  return (
    <div class="gs gs-phone">
      <header class="gs-head">
        <a class="btn btn-icon btn-ghost gs-back" href={back ?? h.href({ name: 'folders' })} aria-label="뒤로">
          <Icon name="back" size={22} />
        </a>
        <div class="gs-titles">
          <h1>Git</h1>
          {sub && <p class="gs-sub">{sub}</p>}
        </div>
        <Refresh g={g} size={20} />
      </header>
      <ConnBanner class="gs-banner" />
      <div class="gs-scroll">
        {g.state !== 'ok' ? (
          <StateNote g={g} />
        ) : (
          <>
            <BranchCard g={g} />
            {g.shown && (
              <a class="gs-card gs-graph" href={graphHref(h, g)} onClick={fromHere(h, g)}>
                <Icon name="graph" size={20} class="gs-graph-icon" />
                <span class="gs-graph-text">
                  <span class="gs-graph-title">커밋 그래프</span>{' '}
                  <span class="gs-graph-sub">모든 브랜치의 커밋 기록</span>
                </span>
                <Icon name="chevron-right" size={16} class="gs-graph-go" />
              </a>
            )}
            <PhoneChanges g={g} groups={groups} />
            {list}
          </>
        )}
      </div>
    </div>
  )
}
